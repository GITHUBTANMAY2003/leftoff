# leftoff — Design Spec and Implementation Plan

> **For agentic workers:** Implement this plan inline, one task at a time, with no subagents (owner decision D8 in `docs/reports/task-00-plan-review.md`). Each task follows TDD, ends with a report in `docs/reports/task-NN.md` and an update of `docs/PROGRESS.md`, is committed to `main` with the plan's commit message, and then waits for the owner's `continue`. Each task's commit hash is backfilled into its report and PROGRESS.md by the next task's commit. Steps use checkbox (`- [ ]`) syntax for tracking. Read **Part 1 (Spec)** in full before starting any task — every task argues from it.

**Goal:** A free, open-source, local CLI that remembers what a developer (and their AI coding agent) was doing in each project, and gives it back as a "resume brief" and an auto-written standup when they return.

**Architecture:** Event-driven, no daemon. Tiny capture hooks (Claude Code plugin hooks, a pure-shell terminal hook) record that something happened; collectors read git, shell, Claude Code and Codex logs incrementally into one local SQLite file; a brief builder turns events into deterministic facts, optionally polished by an LLM the user already has.

**Package:** `@leftoff-dev/cli` (command `leftoff`).

**Tech Stack:** Node.js ≥ 22.15, TypeScript `~6.0.3` (ESM, strict), `better-sqlite3`, `commander`, `tsup` (build), `vitest` (tests), `eslint` + `prettier`, GitHub Actions, npm. Compressed Codex logs: Task 7 decides from real files (R-A4) — `node:zlib` zstd if `.jsonl.zst` files exist (this raises `engines` to `>=22.15`, where `node:zlib` gained zstd), otherwise no `.zst` support; `fzstd` is not used either way.

**Spec:** Part 1 of this document.

---

# Part 1 — Design Spec

## 1.1 The problem and the pitch

Developers lose time every time they come back to a project: what was I doing, which branch, what was half-finished, which fixes did I (or my agent) already try? Git shows commits, not context. Today most code is written by AI agents (Claude Code, Codex), so most of that context lives in agent sessions that nobody re-reads.

**Positioning (D11).** leftoff is **not** "memory for AI agents" — that space is taken (Claude Code session recap and auto memory, Codex Memories, claude-mem). Agent memory recalls *knowledge* when asked, inside one agent. leftoff tracks *unfinished state* — uncommitted work, unresolved errors, failing tests, abandoned attempts, and agents that claimed "done" when they weren't — across every project, every agent and the terminal, from ground truth (git, exit codes, test output), and tells the developer unprompted.

**One-line pitch:** "Your agents say they're done. leftoff shows you what's actually left."

**Interview answer to "Claude already has memory":** "Memory helps the agent recall what it learned. leftoff checks what's actually unfinished — from git, exit codes and test results, not an AI's summary — across every project and agent. Memory tells you what happened; leftoff tells you what's still open."

**Example the product must nail:** Rahul builds a "forgot password" feature with Claude Code on Tuesday evening, hits `SMTP connection refused`, the agent tries two fixes that fail, he logs off with uncommitted work. Wednesday morning, opening a terminal in the repo prints:

```
Where you left off — myapp (feature/forgot-password) · last active 14h ago

Done
  • Built POST /auth/forgot-password endpoint
  • Added reset-token migration

Unfinished
  • email_service.py (modified, uncommitted)

Open problems
  ✗ SMTP connection refused
    tried: changed port to 587 · disabled TLS

Next step
  → Resolve: SMTP connection refused

Sources: claude ✓  git ✓  shell ✓  codex –
```

(This is exactly the Task 10 golden file `tests/render/golden/rahul.txt`. Both `Done` lines are commit subjects. With real data, `tried:` items are mechanical event summaries such as `Edited email_service.py`; the wording here comes from the test helper — R-D2.)

And when he starts a new Claude Code session, the agent receives the same brief and does not retry the two failed fixes.

## 1.2 Decisions agreed with the product owner

| # | Decision | Choice |
|---|---|---|
| D1 | Product scope | One complete product, shipped together. No v1/v2 split. |
| D2 | Audience | **Personal, local tool** for an individual developer. Not a team tool. No team digest, no shared channel, no server. The tool never posts anything anywhere. |
| D3 | Data sources | Git + terminal + AI agent sessions. **Agent sessions are the primary source**; agent failures (failed commands, tool errors, failed tests, abandoned attempts) are first-class events. |
| D4 | Agents at launch | **Claude Code fully supported** (hooks + transcripts + brief handed back to the agent). **Codex CLI** via session logs. Collectors are a plug-in interface so Cursor/Gemini/Aider can be added later by contributors. Cursor deliberately excluded at launch (undocumented, changing storage). |
| D5 | Cost | Zero for the builder and the users. No server, no paid API required. |
| D6 | AI usage | Layered: a **deterministic facts-based brief always works** (offline, no keys). Optional "polish" uses what the user already has: their agent CLI (Claude Code / Codex), a local Ollama model, or their own API key. |
| D7 | Where the brief appears | (A) `leftoff resume` command, (B) printed automatically when opening a terminal in a project after a break, (C) injected into new Claude Code sessions. No editor extension. |
| D8 | Architecture | Event-driven, **no daemon**, TypeScript. |
| D9 | Storage | SQLite (embedded, single file, nothing to run). Behind a storage interface so a server DB could be added later. Postgres/MongoDB rejected: they require a running server on every user's laptop. |
| D10 | Quality bar | It must not break the developer's workflow. Failures degrade gracefully and are visible in `leftoff doctor`. |
| D11 | Positioning | A **loose-ends tracker for developers who work with AI agents**, built for the human, not the agent. Headline features: open loops in the brief, a cross-project loose-ends view (`leftoff` with no arguments), and "agent claimed done vs. actually done" detection — all deterministic. Handing the brief to a new Claude Code session stays, as a secondary feature. |
| D12 | Release gate | **Dogfood before public release.** The owner uses leftoff daily on real projects and a small private beta tries it; release happens only when the exit criteria in Task 17 are met. |
| D13 | Shipping | **No Docker.** leftoff must run on the host to read the user's shell, git repos and agent logs; a container would isolate it from all three. Shipped as an npm global package plus a Claude Code plugin. Docker is used only as a clean Linux test machine. |

## 1.3 Decisions made while writing this plan (product owner: review these)

| # | Decision | Choice |
|---|---|---|
| P1 | Name | Product and command: **`leftoff`**. npm package: **`@leftoff-dev/cli`** (plain `leftoff` is blocked by npm as too similar to `liftoff`; the `leftoff` org name is unavailable). Placeholder `0.0.1` already published under the `leftoff-dev` npm org. GitHub: `github.com/GITHUBTANMAY2003/leftoff` (may move to a `leftoff-dev` GitHub org later; GitHub redirects). |
| P2 | Platforms | macOS and Linux (incl. WSL). Native Windows not supported at launch; `doctor` says so. |
| P3 | Shells | zsh, bash, fish. |
| P4 | Data location | `~/.leftoff/` (override with env `LEFTOFF_HOME`). Directory mode `700`, files `600`. Contents: `leftoff.db`, `config.json`, `shell/` (copied shell scripts + `shell.log`), `bin/leftoff` (CLI shim), `logs/`, `tmp/`. |
| P5 | Project identity | Git top-level directory (`git rev-parse --show-toplevel`); non-git folders use their real path. |
| P6 | Work session | Consecutive events in one project with no gap ≥ `sessionGapMinutes` (default **45**). |
| P7 | Auto-brief trigger | On shell start or `cd` into a project, print a compact brief if the project's last activity was ≥ `autoBrief.gapHours` (default **4**) ago **and** no brief has been shown since that activity. Disable with config or env `LEFTOFF_QUIET=1`. `brief --auto` never waits for ingest, but spawns a detached background ingest at most once every 10 minutes so terminal-only users get fresh data and raw `shell.log` lines don't pile up (R-D3). |
| P8 | Claude Code hooks | `SessionStart` (matcher `startup|clear|compact`; `resume` and `fork` excluded on purpose because those sessions already carry their transcript — R-C2) injects the brief; `Stop` records a checkpoint; `SessionEnd` records the end and **always** starts a short detached background summarize, which always ingests and calls a polish provider only if polish is enabled (R-B1). Hooks call the shim `~/.leftoff/bin/leftoff` when it exists, else `leftoff` on PATH (R-C4). |
| P9 | Retention | Events older than `retentionDays` (default **30**) are pruned. |
| P10 | Privacy | Secrets are redacted **before** storage. Commands typed with a leading space are never recorded. Projects/commands can be ignored by config. `leftoff forget` deletes data. Polish providers that send data off-machine are only used if the user enabled them in `setup`. Default polish without setup: `off`. |
| P11 | Manual notes | `leftoff note "text"` adds a note to the current project's timeline; notes always appear in the brief. |
| P12 | Distribution | npm (`npm i -g @leftoff-dev/cli && leftoff setup`), Claude Code plugin + marketplace manifest in the same GitHub repo (marketplace name `leftoff`, plugin id `leftoff@leftoff`; dogfooding adds the marketplace from the local repo path — R-C8), MIT license. |

**Plan review decisions.** References like `R-B6` point to item B6 in `docs/reports/task-00-plan-review.md`, as answered by the owner on 2026-10-24. Each decision is applied in the section or task it affects:

| Ref | Decision | Applied in |
|---|---|---|
| R-A1, R-A2, R-A5, R-A6, R-A7 | TypeScript `~6.0.3`; `engines >=22.12`; CI on Node 22/24/26; `.ts` import extensions; unit vs e2e test split; `prettier --check` in `check` | Global Constraints, Task 1 |
| R-A4, R-C5 | `.zst` support and its library decided from real Codex files | Task 7 |
| R-B1 | SessionEnd always spawns background summarize (ingest always, polish only if enabled) | P8, Tasks 12, 13 |
| R-B2, R-B3 | `Notes` section; §1.1 brief = golden file (subjects without hash, no footer, fixed Sources order) | §1.1, §1.8, Task 10 |
| R-B4 | Standup drops "Worked on" when the project has commits in the window | Task 11 |
| R-B5, R-B6 | `Collector.afterCommit?`; `shell.log` rotated by rename, never rewritten in place | §1.6, Tasks 4, 8 |
| R-B7 | bash < 5: second-resolution timestamp, unknown duration | Task 4 |
| R-B8 | Shell scripts copied to `~/.leftoff/shell/`, rc block sources them behind a `[ -r … ]` guard | Tasks 4, 15 |
| R-B9 | Full `Config` shape, `config.json`, comma-separated lists | Task 1 |
| R-B10 | Malformed counts as warnings; last ingest report stored in `cursors` | Tasks 8, 15 |
| R-C4 | CLI shim `~/.leftoff/bin/leftoff` used by plugin hooks | P8, Tasks 13, 15 |
| R-C6 | Honor `CLAUDE_CONFIG_DIR` and `CODEX_HOME` | §1.6, Tasks 6, 7 |
| R-C7 | Safer polish CLI flags | §1.9, Task 12 |
| R-D1 | Uncommitted files are a "claimed done" contradiction only when the claim says committed/pushed/merged/ready to merge | §1.7, Task 9, Review Focus 6 |
| R-D3 | `brief --auto` spawns a background ingest at most every 10 minutes | P7, Task 14 |
| R-D4, R-D5 | Claude first run limited to `retentionDays`; reader perf test uses 60 MB | Task 6 |
| R-D6 | Redaction word-boundary regression tests | Task 3 |
| R-D7 | Shell tests skip when the shell binary is missing; CI installs zsh and fish | Tasks 1, 4, 14 |

## 1.4 Components

```
CAPTURE (tiny, never fails)   INGEST + STORE                   OUTPUT
Claude Code plugin hooks ──┐  Collectors (git, shell,          leftoff resume
Shell hook (zsh/bash/fish) ├─> claude, codex) ─> SQLite  ─>    auto brief on terminal open
Read on demand:            │   (cursors: read only new data)   brief injected into Claude Code
  git, transcripts, codex ─┘   Brief builder: facts → optional AI polish   leftoff standup / doctor
```

1. **Capture** — records only that something happened. Must never crash, never print to stdout unless that output is the contract, never slow the user down.
   - Shell hook: pure shell, copied by `setup` to `~/.leftoff/shell/leftoff.{zsh,bash,fish}`, appends one TSV line per command to `~/.leftoff/shell/shell.log`. No Node process per command.
   - Claude Code plugin hooks call `leftoff hook <name>` through the shim `~/.leftoff/bin/leftoff` (falling back to `leftoff` on PATH).
2. **Collectors** — one per source, all implementing the same `Collector` interface. Each converts raw data into `WorkEvent`s and stores a cursor so the next run reads only new data.
3. **Store** — one SQLite file `~/.leftoff/leftoff.db` (WAL mode). Tables: `events`, `cursors`, `briefs`, `brief_views`, `locks`.
4. **Brief builder** — groups events into work sessions, extracts `BriefFacts` deterministically, renders terminal / markdown / JSON, and optionally attaches a cached polished summary.

## 1.5 Event model

```ts
type Source = 'git' | 'shell' | 'claude' | 'codex' | 'user';
type EventKind =
  | 'session_start' | 'session_end' | 'checkpoint'
  | 'user_prompt' | 'agent_message'
  | 'file_edit' | 'command' | 'command_failed' | 'tool_error' | 'test_failed'
  | 'commit' | 'branch_switch' | 'note';

interface WorkEvent {
  source: Source;
  kind: EventKind;
  projectRoot: string;     // absolute path, see P5
  ts: string;              // ISO 8601 UTC
  sessionRef: string | null; // agent session id, shell pid, etc.
  summary: string;         // redacted, ≤ 300 chars
  data: Record<string, unknown>; // redacted, serialized ≤ 4096 bytes
  dedupeKey: string;       // stable id; re-reading the same data never duplicates
}
```

## 1.6 What each collector captures

| Collector | Reads | Emits |
|---|---|---|
| git | On demand per project: current branch, `git status --porcelain=v2`, `git diff --stat`, commits since cursor, branch switches from reflog | `commit`, `branch_switch`; uncommitted state is read live into facts (not stored as events) |
| shell | `~/.leftoff/shell/shell.log`, rotated by rename before reading (`shell.log` → `shell.log.<pid>.ingesting`) so shells keep appending to a fresh file; the renamed file is deleted after commit so raw lines don't linger (R-B6) | `command`, `command_failed` (exit ≠ 0) |
| claude | Claude Code transcripts (`$CLAUDE_CONFIG_DIR/projects/**/*.jsonl`, default `~/.claude/projects`, plus paths reported by hooks), byte-offset cursor per file; the first run only considers files modified within `retentionDays` | `user_prompt`, `agent_message`, `file_edit` (Edit/Write/MultiEdit tool uses), `command` (Bash tool), `command_failed`/`tool_error` (tool results marked as errors), `test_failed`, `session_start`/`session_end` |
| codex | `$CODEX_HOME/sessions/YYYY/MM/DD/rollout-*.jsonl` (default `~/.codex`; byte-offset cursor) and, only if Task 7 finds them in real data, `*.jsonl.zst` (re-read only when size/mtime change; skipped above `codex.maxCompressedMb`, default 200) | same kinds as claude |

Agent log formats are not formally documented and change between versions. Parsers MUST: ignore unknown line types and fields, skip malformed lines (counting them for `doctor`), never advance a cursor past an incomplete final line, and cap work per run (`ingest.maxBytesPerFilePerRun`, default 50 MB) so `resume` stays fast.

## 1.7 Brief facts (deterministic)

```ts
interface BriefFacts {
  project: { root: string; name: string };
  branch: string | null;
  lastActiveAt: string | null;        // ISO
  window: { from: string; to: string }; // the work sessions summarized
  done: string[];                      // commit subjects, then "Edited N files: a, b, c"
  unfinished: { files: { path: string; status: string }[]; diffStat: string | null };
  lastIntent: string | null;           // last user prompt to an agent, ≤ 300 chars
  lastAgentMessage: string | null;     // ≤ 300 chars
  openProblems: OpenProblem[];
  claimedDone: ClaimedDone | null;     // agent said "done" but ground truth disagrees
  notes: string[];
  nextStep: string | null;
  sources: { name: Source; status: 'ok' | 'not_found' | 'error'; detail?: string }[];
}
interface OpenProblem { error: string; source: Source; firstSeen: string; attempts: string[] }
interface ClaimedDone { source: Source; message: string; at: string; contradictions: string[] }
interface LooseEnds {          // one project's entry in the cross-project view
  project: { root: string; name: string };
  branch: string | null;
  lastActiveAt: string;
  stale: boolean;              // has uncommitted files and last activity ≥ looseEnds.staleDays ago
  claimedDone: ClaimedDone | null;
  openProblems: OpenProblem[];
  uncommittedCount: number;
}
```

Rules:
- **Window:** the most recent work session for the project; if it has fewer than 3 events, include the previous session too.
- **Open problem:** a `command_failed` / `tool_error` / `test_failed` event whose normalized command (whitespace collapsed, leading env assignments removed) is **not** followed later in the window by a successful `command` with the same normalized command. `attempts` = summaries of `file_edit` and `command` events after the failure, newest last, max 5, deduplicated.
- **Next step (first match wins):** newest note starting with `next:` → `Verify: <first claimedDone contradiction>` → `Resolve: <newest open problem error>` → `Finish and commit changes in <first unfinished file>` (+ ` and N more`) → `Continue: <lastIntent>` → `null`.
- **Claimed done:** take the newest `agent_message` in the window whose text matches `/\b(done|completed?|finished|fixed|implemented|all (tests )?pass(ing|ed)?|ready (for review|to merge))\b/i` and does not match `/\b(not|isn't|wasn't|haven't|still)\b.{0,20}\b(done|complete|finished|fixed|passing)\b/i`. Contradictions (each a short string): every open problem from the same agent session or later (`"<error> (still failing)"`); `"<N> uncommitted files"` **only if the claim itself says the work was committed** — the message matches `/\b(committed|pushed|merged|ready to merge)\b/i` — and there are uncommitted files and no `commit` event after the message. Uncommitted files alone are never a contradiction, because many developers review before committing (R-D1); they still appear under `Unfinished`. `claimedDone` is `null` when there is no matching message or no contradiction.
- **Loose ends (cross-project):** for each project with events in the last `retentionDays`, build facts with stored events plus live git state, and include it if it has a claimedDone, an open problem, or uncommitted files. Order: claimedDone first, then by number of open problems (desc), then stale, then oldest `lastActiveAt`. At most `looseEnds.maxProjects` (default **20**) projects are checked, most recently active first.
- **Polish never replaces facts.** A polished paragraph is shown above the facts; facts are always shown.

## 1.8 Output formats (exact copy)

- Terminal brief: headings exactly `Where you left off`, `Agent said done, but`, `Done`, `Unfinished`, `Open problems`, `Notes`, `Next step`, then the `Sources:` line (`✓` ok, `–` not_found, `!` error) in the fixed order `claude`, `git`, `shell`, `codex`. Empty sections are omitted. No footer line after `Sources:`. `Done` items are commit subjects without hashes, then `Edited N files: a, b, c` when present. Respect `NO_COLOR`. The §1.1 example is the exact reference.
- Auto brief (terminal open): first line `Where you left off — <name> (<branch>) · last active <gap>`, at most 6 more lines (unfinished count, top open problem, next step), last line `Run \`leftoff resume\` for details`.
- Agent context (Claude Code `additionalContext`): Markdown starting with `## Previous session in this project (from leftoff)`, ending with the line `This is an automatic summary of earlier work. Verify against the code before relying on it.` Max **4000** characters.
- Standup: three sections `Yesterday:`, `Today:`, `Blockers:` (`Blockers: none` if empty).
- Loose ends (`leftoff` / `leftoff loops`): first line `Loose ends across <N> projects` (or `No loose ends. Everything is committed and passing.`), then per project:
```
myapp (feature/forgot-password) · 14h ago
  ! Agent said "All tests pass" — 1 test still failing
  ✗ SMTP connection refused (2 attempts)
  • 1 uncommitted file
api-server (main) · 4d ago · stale
  • 3 uncommitted files
```
  Last line: `Run \`leftoff resume\` inside a project for details`.

## 1.9 AI polish

- Providers: `claude-cli`, `codex-cli`, `ollama`, `anthropic`, `openai`. Config `polish.provider`: `off` (default before setup) | `auto` (try enabled providers in the order listed) | one provider name. `polish.enabled` lists which providers the user allowed in setup.
- Polish only runs in the **background** (after `SessionEnd`, or `leftoff resume --polish`). Foreground commands use a cached polished summary only if its `facts_hash` matches current facts; otherwise they show facts only. Never block the user on an LLM.
- Input: the `BriefFacts` JSON (≤ 8000 chars). Instruction: rewrite into ≤ 4 sentences, add nothing not present in the facts. Output rejected if empty or > 1200 chars. Timeout 60 s.
- **Recursion guard (R-C7):** first layer — the CLI providers write no session at all and use no tools: `claude -p --no-session-persistence --tools ""` (never `--bare`: it skips keychain reads, which breaks subscription login on macOS) and `codex exec --ephemeral --skip-git-repo-check -s read-only` (`--skip-git-repo-check` is required because the cwd is not a git repo). Second layer — provider subprocesses run with env `LEFTOFF_INTERNAL=1` and cwd `~/.leftoff/tmp`; all hooks exit immediately when `LEFTOFF_INTERNAL=1`; all collectors ignore events whose project is inside `LEFTOFF_HOME`.
- API providers need the user's key from env (`ANTHROPIC_API_KEY` / `OPENAI_API_KEY`) and a model name chosen in setup (`polish.apiModel`). No model id is hardcoded.

## 1.10 Commands

| Command | Purpose |
|---|---|
| `leftoff setup` | Interactive: detect shells and agents, write the CLI shim `~/.leftoff/bin/leftoff`, copy shell scripts to `~/.leftoff/shell/`, install shell hook block into rc files, install the Claude Code plugin, choose polish provider. Idempotent; the shim and scripts are refreshed on every run. |
| `leftoff resume [--project <path>] [--json\|--md] [--polish]` | Full brief for the project of cwd (or `--project`). |
| `leftoff standup [--since <yesterday\|today\|Nh\|YYYY-MM-DD>] [--all] [--copy]` | Standup text; `--all` covers every project; `--copy` uses pbcopy / wl-copy / xclip if present. |
| `leftoff` (no arguments) / `leftoff loops [--json]` | **Loose ends across all projects** (§1.7, §1.8). The headline command. |
| `leftoff note "<text>"` | Add a note to the current project. |
| `leftoff status` | Tracked projects, last ingest per collector, event counts. |
| `leftoff doctor` | Health checks with a fix hint for each failure. Exit code 1 if any check fails. |
| `leftoff forget (--project <path> \| --all)` | Delete stored data (asks for confirmation unless `--yes`): all events, cached briefs and shown markers. Read positions (cursors: file paths and offsets, no content) are kept so forgotten history isn't re-imported. |
| `leftoff config (get <key> \| set <key> <value> \| list)` | Read/write config. |
| `leftoff uninstall` | Remove rc blocks, print the plugin uninstall command, optionally delete data. |
| hidden: `leftoff hook <claude-session-start\|claude-stop\|claude-session-end>`, `leftoff brief --auto`, `leftoff internal summarize --project <path>`, `leftoff internal ingest` | Used by hooks and background jobs. |

## 1.11 Reliability rules (apply everywhere)

- Hooks (`leftoff hook …`, `leftoff brief --auto`, shell scripts): **always exit 0**, never write anything to stdout except their contract output, finish within their budget (session-start 2 s, others 500 ms, `brief --auto` 300 ms) or give up silently.
- Every error is appended to `~/.leftoff/logs/leftoff.log` (rotated at 1 MB, keep 2 files). `doctor` shows the last 5.
- One failing collector never prevents a brief. Its status shows as `!` and in `doctor`.
- SQLite: WAL, `busy_timeout = 2000`, schema versioned with `PRAGMA user_version`. If the DB fails to open as a valid database, move it to `leftoff.db.corrupt-<timestamp>`, create a fresh one, log it.
- Only one background summarize per project at a time (lease in `locks`, 120 s expiry). Only one background ingest at a time (lease `ingest:bg`, same pattern).

## 1.12 Success criteria

- Install + setup in under 5 minutes on a fresh macOS/Linux machine with Node 22.
- `leftoff resume` p95 < 300 ms with no new data to ingest; < 1.5 s with 50 MB of new agent logs.
- Shell hook adds < 5 ms per command.
- Hooks never make Claude Code wait more than their budget and never surface an error to the agent.
- `leftoff loops` < 1.5 s with 20 tracked projects.
- The brief for the §1.1 scenario contains: the branch, the uncommitted file, the open problem with both attempts, and next step `Resolve: SMTP connection refused`.

---

# Part 2 — Implementation Plan

## Global Constraints

- Node `>=22.15` (`>=22.12` for `commander@15`, raised in Task 7 because `.jsonl.zst` Codex sessions exist and `node:zlib` gained zstd in 22.15; R-A2, R-A4); `"type": "module"`; TypeScript `~6.0.3` pinned (`typescript-eslint` does not support TypeScript 7; R-A1), `strict: true`, target ES2022.
- Imports use `.ts` extensions; `tsconfig.json` sets `allowImportingTsExtensions`, `rewriteRelativeImportExtensions` and `erasableSyntaxOnly` (no `enum`, no parameter properties), so test child processes can run the TypeScript source with Node's built-in type stripping (R-A5).
- Runtime dependencies limited to: `better-sqlite3`, `commander` (Task 7 adds no library: `node:zlib` handles zstd if needed). Anything else needs a written reason and the owner's approval.
- Scripts: `build` (tsup), `test` (unit tests), `test:e2e` (`npm run build` then the e2e tests), `format` (`prettier --write .`), `check` (`tsc --noEmit && eslint . && prettier --check . && vitest run --project unit`). `vitest.config.ts` defines two projects: `unit` (`tests/**`, excluding `tests/e2e/**`) and `e2e` (`tests/e2e/**`). `.prettierignore` excludes `docs/`, `tests/fixtures/` (real logs must stay byte-exact), `dist/`, `coverage/` (R-A6, R-A7).
- CI: `ubuntu-latest` and `macos-latest` × Node 22, 24, 26; installs zsh and fish explicitly; runs `npm ci`, `npm run check`, `npm run build`, `npm run test:e2e`. Tests that need a shell binary skip when it is missing locally (R-D7).
- Data dir `~/.leftoff` (env `LEFTOFF_HOME` overrides); dir mode `0o700`, files `0o600`.
- Defaults: `sessionGapMinutes 45`, `autoBrief.gapHours 4`, `retentionDays 30`, `ingest.maxBytesPerFilePerRun 52428800`, `codex.maxCompressedMb 200`, `polish.provider "off"`, `looseEnds.staleDays 3`, `looseEnds.maxProjects 20`.
- Limits: event `summary` ≤ 300 chars, `data` ≤ 4096 bytes serialized, agent context ≤ 4000 chars, polish input ≤ 8000 chars, polish output ≤ 1200 chars.
- Hook budgets: session-start 2000 ms, stop/session-end 500 ms, `brief --auto` 300 ms. Hooks always exit 0.
- Env flags: `LEFTOFF_INTERNAL=1` (skip all hooks), `LEFTOFF_QUIET=1` (no auto brief), `NO_COLOR` respected.
- All timestamps stored as ISO 8601 UTC; displayed in local time.
- Exact output copy from spec §1.8.
- Every task ends with `npm run check` passing (and `npm run test:e2e` once e2e tests exist), then a commit.

## Review Focus

1. **Recursion through polish** — running `claude -p` for polish fires our own hooks and writes a new transcript; expected: no hook output, no events from that session. Test in Task 12 and Task 13.
2. **Hostile agent logs** — multi-GB files, a partial last line still being written, malformed JSON lines, unknown line types after an agent update; expected: ingest stays within budget, never crashes, cursor never skips the partial line. Tests in Tasks 6, 7, 8.
3. **Secrets in commands and transcripts** — tokens, passwords, private keys typed in commands or echoed in tool output; expected: never stored unredacted; raw shell log bytes removed after ingest, with no command lost while shells keep appending; leading-space commands never recorded. Tests in Tasks 3, 4, 8.
4. **Unusual project layouts** — non-git folder, repo with no commits, detached HEAD, nested repo, git worktree, path with spaces; expected: correct project root and a brief without crashing. Tests in Tasks 3, 5.
5. **Concurrency** — two Claude sessions and the shell writing while `resume` reads; two `SessionEnd`s starting summarize at once; expected: no "database is locked" crash, one summarize runs. Tests in Tasks 2, 12.
6. **False "claimed done" alarms** — agent messages like "I haven't finished", "done reading the file, now editing", a claim followed by a fix and a passing re-run, or "Done!" while the developer simply hasn't committed yet; expected: no flag when ground truth agrees, and uncommitted files flag only when the claim says committed/pushed/merged/ready to merge (R-D1), so developers don't learn to ignore it. Tests in Task 9.

---

## File structure

```
package.json, package-lock.json, tsconfig.json, tsup.config.ts, vitest.config.ts,
eslint.config.js, .prettierrc, .prettierignore, .gitignore
src/
  cli/index.ts                      commander wiring, global error handler
  cli/commands/resume.ts note.ts standup.ts loops.ts status.ts doctor.ts setup.ts
               forget.ts config.ts uninstall.ts brief-auto.ts hook.ts internal.ts
  core/paths.ts                     LEFTOFF_HOME, file paths, permissions
  core/config.ts                    load/validate/save config with defaults
  core/logger.ts                    error log with rotation
  core/time.ts                      parse --since, relative "14h ago"
  core/budget.ts                    withBudget(promise, ms) helper
  store/db.ts                       open, WAL, corruption recovery
  store/migrations.ts               schema versions
  store/repo.ts                     Repo interface + SQLite implementation
  model/event.ts                    WorkEvent types, validation, truncation
  model/redact.ts                   secret redaction
  model/project.ts                  resolveProject()
  collectors/types.ts               Collector interface
  collectors/git.ts shell.ts claude.ts codex.ts registry.ts ignore.ts (shared ignore globs, Task 6)
  collectors/jsonl-reader.ts        incremental JSONL reading (plain; zst only if Task 7 needs it)
  collectors/test-failures.ts       test-failure patterns, one place for all frameworks
  ingest/ingest.ts                  run collectors with isolation, pruning
  ingest/background.ts              detached background ingest, rate-limited (Task 14)
  brief/sessions.ts facts.ts next-step.ts hash.ts loose-ends.ts
  render/terminal.ts markdown.ts json.ts standup.ts auto.ts loose-ends.ts
  polish/types.ts chain.ts summarize.ts prompt.ts
  polish/providers/claude-cli.ts codex-cli.ts ollama.ts anthropic.ts openai.ts
  install/shell-rc.ts claude-plugin.ts shim.ts
shell/leftoff.zsh leftoff.bash leftoff.fish   (source copies; setup copies them to ~/.leftoff/shell/)
plugin/.claude-plugin/plugin.json
plugin/hooks/hooks.json
.claude-plugin/marketplace.json
.github/workflows/ci.yml release.yml
tests/  (mirrors src/), tests/fixtures/{claude,codex,shell}/, tests/e2e/
demo/demo.tape
README.md CONTRIBUTING.md LICENSE CHANGELOG.md
docs/leftoff-implementation-plan.md         this document
docs/PROGRESS.md                            task status, commit hashes, deviations
docs/reports/task-NN.md                     one report per task (task-00-plan-review.md = plan review)
docs/adding-a-collector.md docs/dogfood-log.md docs/dogfood-checklist.md
```

---

### Task 1: Project scaffold, paths, config, logger

**Files:**
- Create: `package.json`, `package-lock.json`, `tsconfig.json`, `tsup.config.ts`, `vitest.config.ts`, `eslint.config.js`, `.prettierrc`, `.prettierignore`, `.gitignore`, `.github/workflows/ci.yml`, `src/core/paths.ts`, `src/core/config.ts`, `src/core/logger.ts`, `src/core/budget.ts`, `src/cli/index.ts`
- Test: `tests/core/paths.test.ts`, `tests/core/config.test.ts`, `tests/core/logger.test.ts`, `tests/core/budget.test.ts`

**Interfaces:**
- Produces:
  - `paths(): { home, db, config, shellDir, shellLog, binDir, shim, logDir, logFile, tmp }` (all absolute; honors `LEFTOFF_HOME`; `config` = `<home>/config.json`, `shellDir` = `<home>/shell`, `binDir` = `<home>/bin`, `shim` = `<home>/bin/leftoff`)
  - `ensureHome(): void` (creates dirs with `0o700`)
  - `type Config`, `DEFAULT_CONFIG`, `loadConfig(): Config`, `saveConfig(c: Config): void` (mode `0o600`), `getConfigValue(key: string)`, `setConfigValue(key: string, raw: string): Config`
  - `logError(scope: string, err: unknown): void`, `readRecentErrors(n: number): string[]`
  - `withBudget<T>(p: Promise<T>, ms: number): Promise<T | undefined>`

Config shape and defaults (R-B9):

```ts
{
  sessionGapMinutes: 45,
  retentionDays: 30,
  autoBrief: { enabled: true, gapHours: 4 },
  ingest: { maxBytesPerFilePerRun: 52428800 },
  codex: { maxCompressedMb: 200 },
  collectors: { claude: true, codex: true, shell: true, git: true },
  ignore: { projects: [], commands: [] },          // string[] globs
  polish: { provider: 'off', enabled: [], ollamaModel: null, apiModel: null },
  looseEnds: { staleDays: 3, maxProjects: 20 },
}
```

`setConfigValue` parses list keys (`ignore.projects`, `ignore.commands`, `polish.enabled`) as comma-separated values (items trimmed; `""` = empty list), numbers and booleans strictly, nullable strings with `""` = `null`. Count-type keys (`retentionDays`, `looseEnds.maxProjects`, `ingest.maxBytesPerFilePerRun`, `codex.maxCompressedMb`) must be integers ≥ 0 — `config set` rejects decimals and a decimal in `config.json` falls back to the default; durations (`autoBrief.gapHours`, `sessionGapMinutes`, `looseEnds.staleDays`) may be decimal (owner decision after Task 1).

- [ ] **Step 1: Scaffold.** `package.json` with `"name": "@leftoff-dev/cli"`, `"bin": {"leftoff": "dist/cli.js"}`, `"publishConfig": {"access": "public"}`, `"engines": {"node": ">=22.12"}`, scripts `build`, `test`, `test:e2e`, `format`, `check` as in Global Constraints. `typescript` pinned to `~6.0.3`. `tsconfig.json` with the import flags from Global Constraints. `vitest.config.ts` with the `unit` and `e2e` projects (`test:e2e` passes with no e2e test files until Task 13 adds the first). CI workflow on `ubuntu-latest` and `macos-latest` × Node `22`, `24`, `26`: install zsh and fish, then `npm ci`, `npm run check`, `npm run build`, `npm run test:e2e`.

- [ ] **Step 2: Write failing tests**

```ts
test('paths honor LEFTOFF_HOME', () => {
  process.env.LEFTOFF_HOME = tmp;
  expect(paths().db).toBe(join(tmp, 'leftoff.db'));
  expect(paths().shellLog).toBe(join(tmp, 'shell', 'shell.log'));
});
test('ensureHome creates dirs with 0700', () => {
  ensureHome();
  expect(statSync(tmp).mode & 0o777).toBe(0o700);
});
test('missing config file returns defaults', () => {
  expect(loadConfig()).toEqual(DEFAULT_CONFIG);
  expect(DEFAULT_CONFIG.sessionGapMinutes).toBe(45);
  expect(DEFAULT_CONFIG.autoBrief.gapHours).toBe(4);
  expect(DEFAULT_CONFIG.polish.provider).toBe('off');
});
test('corrupt config file falls back to defaults and logs', () => {
  writeFileSync(paths().config, '{not json');
  expect(loadConfig()).toEqual(DEFAULT_CONFIG);
  expect(readRecentErrors(1)[0]).toMatch(/config/);
});
test('setConfigValue validates types', () => {
  expect(setConfigValue('autoBrief.gapHours', '6').autoBrief.gapHours).toBe(6);
  expect(() => setConfigValue('autoBrief.gapHours', 'abc')).toThrow(/number/);
  expect(() => setConfigValue('nope.key', '1')).toThrow(/unknown key/);
});
test('setConfigValue parses comma-separated lists; "" is empty', () => {
  expect(setConfigValue('ignore.projects', '~/secret/*, /tmp/*').ignore.projects).toEqual(['~/secret/*', '/tmp/*']);
  expect(setConfigValue('ignore.projects', '').ignore.projects).toEqual([]);
});
test('config file is written with mode 0600', () => { /* saveConfig, stat mode */ });
test('log rotates at 1 MB keeping 2 files', () => { /* write >1MB, expect leftoff.log and leftoff.log.1 only */ });
test('withBudget returns undefined after timeout', async () => {
  expect(await withBudget(new Promise(r => setTimeout(() => r(1), 50)), 10)).toBeUndefined();
});
```

- [ ] **Step 3: Run** `npx vitest run --project unit tests/core` → FAIL (modules missing).
- [ ] **Step 4: Implement** the four modules. Config is validated by a hand-written validator (no schema library); unknown keys in the file are dropped with a log line.
- [ ] **Step 5: Run** `npm run check` → PASS.
- [ ] **Step 6: Commit** `git commit -m "chore: scaffold project, paths, config, logger"`

---

### Task 2: SQLite store and repository

**Files:**
- Create: `src/store/db.ts`, `src/store/migrations.ts`, `src/store/repo.ts`
- Test: `tests/store/repo.test.ts`, `tests/store/db.test.ts`

**Interfaces:**
- Consumes: `paths()`, `logError()` (Task 1); `WorkEvent` type (define in `src/model/event.ts` now as a type-only file; Task 3 adds logic).
- Produces:
  - `openDb(file?: string): Database` — WAL, `busy_timeout=2000`, runs migrations, corruption recovery.
  - `interface Repo` and `createRepo(db): Repo` with:
    - `insertEvents(events: WorkEvent[]): number` (`INSERT … ON CONFLICT(dedupe_key) DO NOTHING` — not `INSERT OR IGNORE`, which would also silently drop rows that violate NOT NULL; returns inserted count; one all-or-nothing transaction)
    - `eventsForProject(root: string, sinceIso: string): WorkEvent[]` (ts ascending; a row whose `data` JSON can't be parsed is skipped, one log line per read, never throws — same for `eventsSince`)
    - `eventsSince(sinceIso: string): WorkEvent[]` (all projects)
    - `projects(): { root: string; lastTs: string; count: number }[]`
    - `lastActivity(root: string): string | null`
    - `getCursor(collector: string, key: string): string | null`, `setCursor(collector, key, value): void`
    - `saveBrief(root, factsHash, factsJson, polished: string | null, provider: string | null): void`, `getBrief(root): { factsHash, polished, provider, createdAt } | null`
    - `markBriefShown(root: string, activityIso: string): void`, `briefShownFor(root): string | null`
    - `acquireLock(name: string, holder: string, ttlMs: number): boolean`, `releaseLock(name, holder): void`
    - `pruneOlderThan(iso: string): number`, `deleteProject(root): void`, `deleteAll(): void`

Schema v1:
```sql
CREATE TABLE events(id INTEGER PRIMARY KEY, source TEXT NOT NULL, kind TEXT NOT NULL,
  project_root TEXT NOT NULL, ts TEXT NOT NULL, session_ref TEXT, summary TEXT NOT NULL,
  data TEXT NOT NULL, dedupe_key TEXT NOT NULL UNIQUE);
CREATE INDEX events_project_ts ON events(project_root, ts);
CREATE TABLE cursors(collector TEXT, key TEXT, value TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY(collector, key));
CREATE TABLE briefs(project_root TEXT PRIMARY KEY, facts_hash TEXT, facts_json TEXT, polished TEXT, polish_provider TEXT, created_at TEXT);
CREATE TABLE brief_views(project_root TEXT PRIMARY KEY, last_shown_at TEXT, activity_seen TEXT);
CREATE TABLE locks(name TEXT PRIMARY KEY, holder TEXT NOT NULL, expires_at TEXT NOT NULL);
```

- [ ] **Step 1: Write failing tests**

```ts
test('insertEvents ignores duplicates by dedupeKey', () => {
  expect(repo.insertEvents([ev('a'), ev('a'), ev('b')])).toBe(2);
});
test('eventsForProject returns ascending ts for that project only', () => { ... });
test('cursor round-trip', () => { repo.setCursor('claude', '/f.jsonl', '123'); expect(repo.getCursor('claude', '/f.jsonl')).toBe('123'); });
test('lock: second holder fails until expiry', () => {
  expect(repo.acquireLock('summarize:/p', 'A', 120_000)).toBe(true);
  expect(repo.acquireLock('summarize:/p', 'B', 120_000)).toBe(false);
});
test('expired lock can be taken', () => { /* ttl 1ms, wait 5ms, B succeeds */ });
test('corrupt db file is moved aside and recreated', () => {
  writeFileSync(file, 'garbage');
  const db = openDb(file);
  expect(readdirSync(dir).some(f => f.startsWith('leftoff.db.corrupt-'))).toBe(true);
  expect(createRepo(db).projects()).toEqual([]);
});
test('concurrent writers from two processes do not throw SQLITE_BUSY', async () => {
  // spawn 2 child node processes each inserting 500 events in small transactions; expect total 1000
});
test('pruneOlderThan removes old events only', () => { ... });
```

- [ ] **Step 2: Run** `npx vitest run --project unit tests/store` → FAIL.
- [ ] **Step 3: Implement** `db.ts`, `migrations.ts` (array of SQL strings indexed by version; apply those above `user_version` in a transaction), `repo.ts`. `data` stored as JSON text. Set file mode `0o600` after creation. The concurrency test's child processes import `src/store/*.ts` directly via Node's type stripping (R-A5).
- [ ] **Step 4: Run** `npm run check` → PASS.
- [ ] **Step 5: Commit** `git commit -m "feat(store): sqlite repo with migrations, locks, corruption recovery"`

---

### Task 3: Event model, redaction, project resolution

**Files:**
- Create/complete: `src/model/event.ts`, `src/model/redact.ts`, `src/model/project.ts`
- Test: `tests/model/event.test.ts`, `tests/model/redact.test.ts`, `tests/model/project.test.ts`

**Interfaces:**
- Produces:
  - `makeEvent(input: Omit<WorkEvent, 'summary' | 'data'> & { summary: string; data?: Record<string, unknown> }): WorkEvent` — redacts summary and data, truncates summary to 300 chars (ending `…`), shrinks data to ≤ 4096 bytes by dropping largest string fields first then setting `{ truncated: true }`.
  - `dedupeKey(...parts: (string | number)[]): string` — sha1 hex of parts joined by `\u0000`.
  - `redact(text: string): string`, `redactDeep<T>(value: T): T`
  - `resolveProject(cwd: string): string` — cached per process; git top-level or `realpathSync(cwd)`.
  - `isInsideLeftoffHome(path: string): boolean`
  - `normalizeCommand(cmd: string): string` — collapse whitespace, strip leading `VAR=value` assignments.

Redaction patterns (replace secret part with `[REDACTED]`): AWS access keys `AKIA[0-9A-Z]{16}`, GitHub `gh[pousr]_[A-Za-z0-9]{36,}` and `github_pat_[A-Za-z0-9_]{20,}`, `sk-ant-[A-Za-z0-9_-]{20,}`, `sk-[A-Za-z0-9_-]{20,}`, Slack `xox[abprs]-[A-Za-z0-9-]{10,}`, JWTs `eyJ[\w-]+\.[\w-]+\.[\w-]+`, PEM blocks `-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----`, URL credentials `://user:pass@`, `Bearer <token>`, assignments/flags whose name matches `/(pass(word)?|secret|token|api[_-]?key|auth)/i` (`KEY=value`, `--password value`, `--token=value`, `"password": "value"`) — `pass` and `auth` count only as a whole name segment, so `--author` and `passport` are untouched (owner decision after Task 3); `redactDeep` also replaces any string under a secret-named key; the `NAME=value` rule only starts a name where no name character precedes it (otherwise long words made it quadratic — 100 KB took 16 s; fixed in Task 9 with speed tests); command-specific: `mysql`/`mariadb`/`mysqldump` `-p<value>` (password glued to `-p`) and `sshpass -p <value>` — `-p` in other commands (ports, `mkdir -p`) is untouched (owner decision after Task 3).

- [ ] **Step 1: Write failing tests**

```ts
test.each([
  ['export GITHUB_TOKEN=ghp_' + 'a'.repeat(36), 'export GITHUB_TOKEN=[REDACTED]'],
  ['curl -H "Authorization: Bearer abc.def.ghi"', 'curl -H "Authorization: Bearer [REDACTED]"'],
  ['psql postgres://admin:hunter2@db:5432/x', 'psql postgres://admin:[REDACTED]@db:5432/x'],
  ['mysql --password hunter2 -u root', 'mysql --password [REDACTED] -u root'],
  ['ANTHROPIC_API_KEY=sk-ant-' + 'x'.repeat(30) + ' npm start', 'ANTHROPIC_API_KEY=[REDACTED] npm start'],
])('redacts %s', (input, expected) => expect(redact(input)).toBe(expected));
test('redact leaves ordinary commands alone', () => expect(redact('git commit -m "fix token parsing"')).toBe('git commit -m "fix token parsing"'));
test('redactDeep walks nested objects', () => { ... });
test('makeEvent truncates summary to 300 chars and data to 4096 bytes', () => { ... });
test('resolveProject: subdir of repo → repo root', () => { /* git init tmp, mkdir a/b */ });
test('resolveProject: non-git folder → realpath', () => { ... });
test('resolveProject: repo with no commits, detached HEAD, path with spaces, worktree', () => { ... });
test('normalizeCommand strips env assignments', () => expect(normalizeCommand('  FOO=1  npm   test ')).toBe('npm test'));
test('redact needs word boundaries: "risk-assessment-for-the-quarter" is unchanged', ...); // R-D6
test('redact: "Authorization: Bearer x" is handled by the Bearer rule, not the auth-assignment rule', ...); // R-D6
```

Every redaction pattern that starts with a literal prefix (`sk-`, `gh…_`, `xox…-`, `AKIA`, `eyJ`) is anchored with `\b` (R-D6).

- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** `resolveProject` uses `execFileSync('git', ['-C', cwd, 'rev-parse', '--show-toplevel'], { timeout: 500 })`, catching errors. **Step 4: Run** `npm run check` → PASS.
- [ ] **Step 5: Commit** `git commit -m "feat(model): events, redaction, project resolution"`

---

### Task 4: Shell hook scripts and shell collector

**Files:**
- Create: `shell/leftoff.zsh`, `shell/leftoff.bash`, `shell/leftoff.fish`, `src/collectors/types.ts`, `src/collectors/shell.ts`, `src/install/shell-rc.ts`
- Test: `tests/collectors/shell.test.ts`, `tests/shell/hooks.test.ts`, `tests/install/shell-rc.test.ts`, fixtures `tests/fixtures/shell/*.log`

**Interfaces:**
- Consumes: `makeEvent`, `dedupeKey`, `resolveProject`, `isInsideLeftoffHome`, `Repo` cursors.
- Produces:
  - `interface CollectContext { repo: Repo; config: Config; now: Date; projectFilter?: string; deadline?: number }` — `deadline` is the soft deadline (epoch ms) set by ingest (Task 8)
  - `interface Collector { name: Source; isAvailable(ctx: CollectContext): Promise<boolean>; collect(ctx: CollectContext): Promise<CollectResult>; afterCommit?(ctx: CollectContext): Promise<void> }` — `afterCommit` is optional and is called by ingest only after that collector's events and cursors were committed (R-B5).
  - `interface CollectResult { events: WorkEvent[]; pendingCursors: { key: string; value: string }[]; warnings: string[] }` — collectors only *read* cursors (`ctx.repo.getCursor(name, key)`); ingest (Task 8) inserts the events and commits `pendingCursors` in one transaction.
  - `shellCollector: Collector` (implements `afterCommit`)
  - `installShellScripts(packageShellDir: string, version: string): void` — copies `leftoff.{zsh,bash,fish}` to `paths().shellDir` (mode `0o600`), each with a first line `# leftoff <version>` (R-B8); `installedShellScriptVersion(shell): string | null` for doctor.
  - `installShellHook(shell: 'zsh' | 'bash' | 'fish', rcPath: string, scriptPath: string): 'installed' | 'already'`, `removeShellHook(rcPath: string): boolean`

Shell log line format (one line per command, tab-separated): `ts_epoch_ms \t exit_code \t duration_ms \t pid \t cwd \t command` with tabs/newlines in `cwd`/`command` replaced by spaces; `duration_ms` is `-1` when unknown. `cwd` is the directory where the command started. Scripts:
- zsh: `zmodload zsh/datetime`; `preexec` stores `$EPOCHREALTIME`, `$PWD` and the command; `precmd` appends the line; `chpwd` and first prompt call `leftoff brief --auto` (Task 14 wires this; leave a function `__leftoff_auto` that is a no-op if `leftoff` is missing).
- bash: `PROMPT_COMMAND` prepended (preserve existing; capture `$?` first), uses `history 1`; record only if the history number changed. **Must work on bash 3.2** (the default `/bin/bash` on macOS): no associative arrays, no `PS0`, no `${var,,}`, no `mapfile`; `PROMPT_COMMAND` may be a string, not an array. Timing (R-B7, owner decision after Task 4): the timestamp comes from `$EPOCHREALTIME` on bash ≥ 5 and from `$(date +%s)` × 1000 on bash < 5. The `history 1` approach runs only after a command, so there is no start time on any bash version: `duration_ms` is always `-1` (no `PS0` trick), and `cwd` = `$PWD` at prompt time. Test against `/bin/bash` on macOS CI.
- fish: `fish_preexec` / `fish_postexec` events; duration from `$CMD_DURATION`.
- All: skip if command starts with a space, if `LEFTOFF_INTERNAL=1`, or if the log dir is missing. Never print. File created with `umask 077`. Each line is written with a single `printf … >>` so concurrent shells append whole lines.

rc block (R-B8): delimited by `# >>> leftoff >>>` / `# <<< leftoff <<<`, sources the **copied** script in `~/.leftoff/shell/` behind a guard so a missing file never prints an error — zsh/bash: `[ -r "$HOME/.leftoff/shell/leftoff.zsh" ] && . "$HOME/.leftoff/shell/leftoff.zsh"`; fish: `test -r …; and source …` (paths follow `LEFTOFF_HOME` when set at install time).

Collector (R-B6): `collect` first atomically renames `shell.log` → `shell.log.<ms>.<pid>.ingesting` (unique, and sorting by name processes leftovers oldest first) (if a previous `*.ingesting` file exists from a crashed run, it is processed first), so shells keep appending to a fresh `shell.log` and no line is lost. It splits complete lines only, emits `command` (exit 0) / `command_failed` (exit ≠ 0) with `summary` = redacted command (failed: `` `cmd` exited 1 ``), `sessionRef` = `shell:<pid>`, `data` = `{ exitCode, durationMs, cwd }` (`durationMs: null` when the log says `-1`). Lines whose cwd matches `config.ignore.projects` globs, commands matching `config.ignore.commands`, or inside `LEFTOFF_HOME` are dropped. A partial last line is not consumed. `afterCommit` deletes an `*.ingesting` file only when every byte of it has been committed; a file with unread bytes (a partial line, or a line a shell finished writing after the rename) is kept and read again next run. A partial line in a file nobody has written to for 60 s can never be finished: it is counted as malformed and consumed, never appended back to the live `shell.log`. A single line longer than `ingest.maxBytesPerFilePerRun` is skipped as malformed. If ingest does not commit (error or timeout), the `*.ingesting` file stays and is processed on the next run. Cursor (owner decision after Task 4): **one** row `('shell', 'ingesting')` whose value is a JSON map `{ "<file name>": <committed byte offset> }`, so cursor rows don't pile up for files that no longer exist (`Repo` has no `deleteCursor`).

- [ ] **Step 1: Write failing tests**

```ts
test('parses complete lines and ignores a partial last line', async () => {
  write(log, line(...) + '\n' + line(...) + '\n' + 'partial-no-newline');
  const r = await shellCollector.collect(ctx);
  expect(r.events).toHaveLength(2);
  expect(r.pendingCursors[0].value).toBe(String(byteLengthOfFirstTwoLines));
});
test('exit code != 0 becomes command_failed', ...);
test('redacts secrets in commands', ...);
test('ignored project globs are dropped', ...);
test('real zsh records a command line', () => {
  // skip if zsh missing; run: zsh -i -c 'source shell/leftoff.zsh; precmd-simulated...'
  // simpler: zsh -fc 'source shell/leftoff.zsh; __leftoff_preexec "echo hi"; __leftoff_precmd'
  expect(readFileSync(log, 'utf8')).toMatch(/\t0\t\d+\t\d+\t.*\techo hi\n$/);
});
test.each(['bash', 'fish'])('%s hook records a command line', ...); // skip when the binary is missing (R-D7)
// The hook tests type commands into real interactive shells fed from stdin. fish only emits
// fish_preexec/fish_postexec when reading from a terminal, so fish runs under a pseudo-terminal
// made by `script` (util-linux: `script -qec "<cmd>" /dev/null`; macOS: `script -q /dev/null <cmd>`),
// skipped with a stated reason when neither form works. Tests that check "records nothing" also
// show, in the same run, that a normal command IS recorded once the condition is removed.
test('bash writes duration -1 (every version), collector stores durationMs null', ...); // R-B7
test('leading-space command is not recorded', ...);
test('lines appended after the rename land in the new shell.log and are read next run', ...); // R-B6
test('afterCommit deletes a fully committed ingesting file and keeps one with unread bytes', ...); // R-B6
test('installShellScripts copies scripts with a version header and mode 0600', ...); // R-B8
test('rc block sources the copied script behind a [ -r ] guard; missing script prints nothing', ...); // R-B8
test('installShellHook is idempotent and removable', () => {
  expect(installShellHook('zsh', rc, script)).toBe('installed');
  expect(installShellHook('zsh', rc, script)).toBe('already');
  expect(readFileSync(rc, 'utf8')).toContain('# >>> leftoff >>>');
  expect(removeShellHook(rc)).toBe(true);
  expect(readFileSync(rc, 'utf8')).not.toContain('leftoff');
});
```

- [ ] **Step 2: Run** → FAIL. **Step 3: Implement** scripts, collector, script copier, rc installer (block as described above). **Step 4: Run** `npm run check` → PASS.
- [ ] **Step 5: Commit** `git commit -m "feat(shell): shell hooks, shell collector, rc installer"`

---

### Task 5: Git collector

**Files:**
- Create: `src/collectors/git.ts`
- Test: `tests/collectors/git.test.ts`

**Interfaces:**
- Consumes: `Collector`, `CollectContext`, `makeEvent`, `dedupeKey`.
- Produces:
  - `gitCollector: Collector` — for each known project (from `repo.projects()` plus `ctx.projectFilter`) that is a git repo: emits `commit` events for commits after the cursor (cursor key = project root, value = last seen commit hash; first run takes commits from the last 7 days), `branch_switch` events from `git reflog` entries `checkout: moving from X to Y` after the cursor time.
  - `readWorkingState(root: string): { branch: string | null; files: { path: string; status: string }[]; diffStat: string | null }` — live read used by facts (Task 9). Detached HEAD → `branch = 'detached@<short-sha>'`. No commits → `branch` from `git symbolic-ref --short HEAD`, files from status.

All git calls via `execFile` with `timeout: 1000` and `maxBuffer: 1_000_000`; failure → collector warning, not a throw.

Only your own commits (owner decision after Task 5): `commit` events are limited to commits whose author email equals that repo's own `git config user.email` (read per repo, matched case-insensitively), and merge commits are skipped (`--no-merges`), so teammates' commits arriving with `git pull` never show as Done or in the standup. If `user.email` isn't set, all commits are kept and that is logged once per repo. The cursor is one row per project: JSON `{ commit, reflogAt, reflogKeys, noEmailLogged }`.

- [ ] **Step 1: Write failing tests** (temp repos)

```ts
test('emits commits after cursor once', async () => {
  commit('a'); commit('b');
  expect((await gitCollector.collect(ctx)).events.map(e => e.summary)).toEqual(['a', 'b']);
  // after cursors committed, second run returns []
});
test('emits branch_switch from reflog', ...);
test('readWorkingState lists modified and untracked files', () => {
  expect(readWorkingState(root).files).toEqual([{ path: 'email_service.py', status: 'modified' }, { path: 'new.txt', status: 'untracked' }]);
});
test('readWorkingState: detached HEAD, no commits, not a repo', ...);
test('git missing on PATH → warning, no throw', ...);
```

- [ ] **Step 2: Run** → FAIL. **Step 3: Implement** (parse `git log --format=%H%x1f%aI%x1f%s`, `git status --porcelain=v2 --branch`, `git diff --stat --no-color | tail -1`). **Step 4: Run** `npm run check` → PASS.
- [ ] **Step 5: Commit** `git commit -m "feat(git): git collector and working state"`

---

### Task 6: Incremental JSONL reader and Claude Code collector

**Files:**
- Create: `src/collectors/jsonl-reader.ts`, `src/collectors/claude.ts`
- Test: `tests/collectors/jsonl-reader.test.ts`, `tests/collectors/claude.test.ts`, fixtures `tests/fixtures/claude/*.jsonl`

**Interfaces:**
- Produces:
  - `readJsonlFrom(file: string, offset: number, maxBytes: number): Promise<{ records: { value: unknown; endOffset: number }[]; nextOffset: number; malformed: number }>` — streams from `offset`, returns only complete lines, `nextOffset` = end of last complete line, stops after `maxBytes`. If the file is now smaller than `offset` (rotated/truncated), restarts from 0.
  - `claudeCollector: Collector`
  - `parseClaudeRecord(rec: unknown, file: string, endOffset: number): WorkEvent[]` (exported for tests)

- [ ] **Step 1: Capture real fixtures first.** Run Claude Code on a scratch repo: a session with a prompt, an Edit, a successful Bash, a failing Bash (`ls /nope`), a failing test run, and an abandoned retry. Copy the transcript from `~/.claude/projects/<dir>/<session>.jsonl` to `tests/fixtures/claude/session-basic.jsonl`; redact anything personal by hand. Add `session-malformed.jsonl` (same + 2 corrupted lines + unknown `type` values) and `session-partial.jsonl` (last line cut mid-JSON). Write `tests/fixtures/claude/README.md` recording the Claude Code version used. Verify the hook stdin fields (`session_id`, `transcript_path`, `cwd`, `hook_event_name`, `source`/`reason`) against https://code.claude.com/docs/en/hooks and record them in that README.

- [ ] **Step 2: Write failing tests**

```ts
test('reader returns complete lines only and correct nextOffset', ...);
test('reader restarts at 0 when file shrank', ...);
test('reader stops at maxBytes and resumes next call', ...);
test('reader handles a 60 MB synthetic file within 3 s for the first 50 MB', ...); // perf, mark .skipIf(process.env.CI_FAST) (R-D5)
test('basic session → expected kinds in order', async () => {
  const kinds = (await collectFixture('session-basic.jsonl')).map(e => e.kind);
  expect(kinds).toEqual(expect.arrayContaining(['user_prompt', 'file_edit', 'command', 'command_failed', 'test_failed', 'agent_message']));
});
test('failed Bash tool result is linked to its command', async () => {
  const failed = events.find(e => e.kind === 'command_failed')!;
  expect(failed.summary).toContain('ls /nope');
  expect(failed.data.error).toBeDefined();
});
test('project root comes from record cwd', ...);
test('malformed and unknown lines are skipped and counted', ...);
test('partial last line is not consumed', ...);
test('re-reading the same file yields no new events (dedupe keys stable)', ...);
test('sessions whose cwd is inside LEFTOFF_HOME are ignored', ...); // Review Focus 1
test('CLAUDE_CONFIG_DIR relocates the projects directory', ...); // R-C6
test('first run (no cursors) only considers files modified within retentionDays', ...); // R-D4
```

- [ ] **Step 3: Run** → FAIL. **Step 4: Implement.**
  - Base directory: `$CLAUDE_CONFIG_DIR` if set, else `$HOME/.claude` (R-C6).
  - Ignored projects (owner decision after Task 4): move the glob helper from `src/collectors/shell.ts` to a shared module (`src/collectors/ignore.ts`) and drop events whose project root (or a folder above it) matches `config.ignore.projects`, exactly as the shell collector does.
  - Discovery: union of transcript paths from `session_start`/`checkpoint`/`session_end` hook events and files under `<base>/projects/` with mtime newer than the newest stored claude cursor update minus 1 day; with no claude cursors yet, mtime within the last `retentionDays` (R-D4).
  - Mapping (from the fixtures): user text messages → `user_prompt`; assistant text → `agent_message` (keep last 300 chars); tool uses named `Edit`/`Write`/`MultiEdit`/`NotebookEdit` → `file_edit` with `data.path`; `Bash` → `command` with the command string; a tool result flagged as an error → `command_failed` (if its tool use was Bash) else `tool_error`; a **failed** Bash result whose output looks like a failed test run → also `test_failed`. The patterns live in one place, `src/collectors/test-failures.ts` (owner decision after Task 6): `N failed` / `N failing` with N ≥ 1 (pytest, jest, vitest, mocha), Node `ℹ fail N` and TAP `# fail N` with N ≥ 1, Go `--- FAIL:` and a `FAIL` line, cargo `test result: FAILED`, and `AssertionError`. Zero counts never match. Contributors add a framework there with a passing and a failing test case. Tool results are matched to tool uses by id within the file (keep a per-file map of the last 500 tool uses in the cursor value as JSON if needed, or re-derive from the record).
  - Dedupe key: `dedupeKey('claude', file, endOffset, index)`.
  - Cursor key = file path, value = `nextOffset`.
- [ ] **Step 5: Run** `npm run check` → PASS.
- [ ] **Step 6: Commit** `git commit -m "feat(claude): incremental jsonl reader and claude code collector"`

---

### Task 7: Codex CLI collector

**Files:**
- Create: `src/collectors/codex.ts` (and, only if `.zst` files exist, extend `jsonl-reader.ts` with `readZstJsonl`)
- Test: `tests/collectors/codex.test.ts`, fixtures `tests/fixtures/codex/*.jsonl` (and `*.jsonl.zst` if applicable)

**Interfaces:**
- Produces:
  - Only if `.zst` files exist: `readZstJsonl(file: string, skipLines: number): Promise<{ records: unknown[]; totalLines: number; malformed: number }>` (uses `node:zlib` zstd; R-A4)
  - `codexCollector: Collector`, `parseCodexRecord(rec: unknown, file: string, pos: number): WorkEvent[]`

- [ ] **Step 0: Check access.** Run `codex --version` and try one short session. If Codex cannot run a session with the developer's current login, stop and ask whether to defer this task: if deferred, ship with the codex collector disabled (`collectors.codex = false`), keep the `Collector` interface ready, and note it in README as "coming soon".
- [ ] **Step 1: Capture real fixtures** from `$CODEX_HOME/sessions/YYYY/MM/DD/rollout-*.jsonl` (default `~/.codex`; owner approves listing and copying) with the same scenario as Task 6. Record the Codex version in `tests/fixtures/codex/README.md`.
- [ ] **Step 1b: Decide `.zst` support (R-A4, R-C5).** List the file names under `$CODEX_HOME/sessions/`. If `*.jsonl.zst` files exist: implement `readZstJsonl` with `node:zlib` zstd, raise `engines` to `>=22.15`, produce a `.zst` fixture with `zstd`, and keep `codex.maxCompressedMb`. If none exist: no `.zst` support; remove `codex.maxCompressedMb` from `Config` and the spec. Either way record the outcome in the report and PROGRESS.md.
- [ ] **Step 2: Write failing tests**

```ts
test('plain rollout → same kinds as claude scenario', ...);
test('project root from session metadata cwd', ...);
test('zst file read fully once, skipped when size+mtime unchanged', ...);   // only with .zst support
test('zst file above codex.maxCompressedMb is skipped with a warning', ...); // only with .zst support
test('missing ~/.codex → isAvailable false, no throw', ...);
test('CODEX_HOME relocates the sessions directory', ...); // R-C6
test('unknown record types ignored', ...);
```

- [ ] **Step 3: Run** → FAIL. **Step 4: Implement.** Base directory: `$CODEX_HOME` if set, else `$HOME/.codex` (R-C6). Events whose project matches `config.ignore.projects` are dropped, using the shared helper from Task 6. Plain files: byte cursor as in Task 6. `.zst` (if supported): cursor value = `JSON.stringify({ size, mtimeMs, lines })`; when size or mtime changes, decompress and skip the first `lines` records. Map records using the fixtures. Found in codex-cli 0.163.0 (see `tests/fixtures/codex/README.md`): events come **only** from `event_msg` records of type `item_completed` (`UserMessage` → `user_prompt`, `AgentMessage` → `agent_message`, `CommandExecution` → `command` / `command_failed` with the real exit code, plus `test_failed` via the shared patterns, `FileChange` → `file_edit` per path); the `response_item` records repeat the same content (tool calls are JavaScript snippets) and are ignored. `session_meta` / `turn_context` give the cwd, carried in the cursor between runs. Dedupe key = `(thread_id, record ordinal, index)`, independent of the file path, so a session read as `.jsonl` and later as `.jsonl.zst` adds no rows. `parseCodexRecord(rec, state)` takes the session state instead of `(file, pos)`. Codex also has `thread_history_1.sqlite` ("paginated thread history"), which is not read; it may replace rollout files in a future version. **Step 5: Run** `npm run check` → PASS.
- [ ] **Step 6: Commit** `git commit -m "feat(codex): codex collector with plain and zstd rollouts"`

---

### Task 8: Ingest orchestrator

**Files:**
- Create: `src/collectors/registry.ts`, `src/ingest/ingest.ts`
- Test: `tests/ingest/ingest.test.ts`

**Interfaces:**
- Consumes: all collectors, `Repo`, `withBudget`, `logError`.
- Produces:
  - `collectors(config: Config): Collector[]` — enabled ones from `config.collectors`, order: claude, codex, shell, git.
  - `ingest(ctx: CollectContext, opts?: { budgetMs?: number }): Promise<IngestReport>`
  - `interface IngestReport { perSource: Record<Source, { status: 'ok' | 'not_found' | 'error'; inserted: number; warnings: string[]; detail?: string }>; prunedEvents: number }`

Contract: each collector runs in its own try/catch under `withBudget` (default `budgetMs` 1200 split evenly; a timed-out collector reports `error` with `detail: 'timeout'` and its cursors are not committed — the hard timeout is a safety net; a result after it is discarded).

Soft deadline (owner decision after Task 8 — a large first backlog must never starve): ingest sets `ctx.deadline = start + 60% of the collector's slice`. Every collector always completes its first unit of work, then checks the deadline **between units** — Claude/Codex/shell files, git projects, the JSONL reader's 1 MiB chunks, the zst reader's 1000-line batches — stops starting new work once it has passed, and returns the events and `pendingCursors` for what it completed, so partial progress is always committed. Files/projects not reached keep their old cursor. Units are taken **least recently read first** (a `readAt` / `checkedAt` in each cursor), so an always-active session can't starve the rest. A file with no new data is not a unit. Tests: a backlog larger than one run's budget finishes over several runs with no duplicates and no lost lines, for each collector, plus rotation tests. For each collector: insert events, then commit `pendingCursors`, both in one transaction (so a crash between them cannot skip data). After that transaction commits, call the collector's `afterCommit` if it has one (R-B5; the shell collector deletes its rotated `*.ingesting` file there — R-B6); an `afterCommit` error is logged and reported as a warning, never thrown. Prune events older than `retentionDays` at most once per hour (timestamp in `cursors` as `('ingest','last_prune')`).

Malformed lines (R-B10): collectors report them in `warnings` as `malformed:<count>:<file>`. After each run, ingest stores the `IngestReport` as JSON in `cursors` under `('ingest','last_report')`; doctor (Task 15) reads it from there.

- [ ] **Step 1: Write failing tests**

```ts
test('one collector throwing does not stop others', async () => {
  const report = await ingest(ctxWith([throwing, okCollector]));
  expect(report.perSource.claude.status).toBe('error');
  expect(report.perSource.git.status).toBe('ok');
});
test('cursor not committed when insert fails', ...);
test('timeout marks collector error and keeps old cursor', ...);
test('shell.log processed bytes are removed after commit; unprocessed partial line kept', ...); // Review Focus 3
test('afterCommit is not called when the insert fails or the collector times out', ...); // R-B5
test('last IngestReport with malformed warnings is stored in cursors', ...); // R-B10
test('prunes old events at most hourly', ...);
test('ingest while another process holds a write transaction waits instead of throwing', ...); // Review Focus 5
```

- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** `npm run check` → PASS.
- [ ] **Step 5: Commit** `git commit -m "feat(ingest): isolated collector runs with transactional cursors"`

---

### Task 9: Work sessions and brief facts

**Files:**
- Create: `src/brief/sessions.ts`, `src/brief/facts.ts`, `src/brief/next-step.ts`, `src/brief/hash.ts`
- Test: `tests/brief/sessions.test.ts`, `tests/brief/facts.test.ts`, `tests/brief/next-step.test.ts`

**Interfaces:**
- Consumes: `Repo.eventsForProject`, `readWorkingState` (Task 5), `normalizeCommand`, `IngestReport` (for `sources`).
- Produces:
  - `splitSessions(events: WorkEvent[], gapMinutes: number): WorkEvent[][]`
  - `buildFacts(root: string, deps: { repo: Repo; config: Config; report: IngestReport | null; working: ReturnType<typeof readWorkingState> | null; now: Date }): BriefFacts`
  - `findOpenProblems(events: WorkEvent[]): OpenProblem[]`
  - `chooseNextStep(f: Omit<BriefFacts, 'nextStep'>): string | null`
  - `detectClaimedDone(events: WorkEvent[], openProblems: OpenProblem[], uncommittedCount: number): ClaimedDone | null`
  - `factsHash(f: BriefFacts): string` (sha1 of JSON excluding `lastActiveAt` and `sources`)

- [ ] **Step 1: Write failing tests** — build the §1.1 Rahul scenario as an event list helper `rahulEvents()` used here and in Tasks 10, 11 and 16. It contains two `commit` events with subjects `Built POST /auth/forgot-password endpoint` and `Added reset-token migration` (R-B3), the SMTP failure, and the two attempts.

```ts
test('splits on 45 min gap', ...);
test('window includes previous session when last has < 3 events', ...);
test('open problem: failure without later success', () => {
  const p = findOpenProblems(rahulEvents());
  expect(p).toHaveLength(1);
  expect(p[0].error).toContain('SMTP connection refused');
  expect(p[0].attempts).toEqual(['changed port to 587', 'disabled TLS']); // summaries from fixture helper
});
test('failure followed by same command succeeding is resolved', ...);
test('claimed done: "All tests pass" then a test failure → flagged with "(still failing)"', ...);
test('claimed done: "Done!" with uncommitted files and no later commit → null (uncommitted alone is not a contradiction)', ...); // R-D1
test.each(['Committed the fix', 'Pushed to origin', 'Merged into main', 'Ready to merge'])
  ('claimed done: %j with 2 uncommitted files and no later commit → "2 uncommitted files"', ...); // R-D1
test('claimed done: "Committed the fix" followed by a commit event → null', ...); // R-D1
test('claimed done: claim, then failure, then fix and passing re-run → null', ...);
test.each(["I haven't finished the migration", 'not done yet', "it's still not passing"])
  ('claimed done: negation %j is never a claim', ...);
test('claimed done: "Done reading the file, now editing" with nothing contradicting → null', ...);
test('claimed done: no agent message → null', ...);
test('attempts capped at 5 and deduplicated', ...);
test.each([
  ['note next: wins', { notes: ['next: try OAuth app password'] }, 'try OAuth app password'],
  ['claimed done next', { claimedDone: cd(['1 test still failing']) }, 'Verify: 1 test still failing'],
  ['open problem next', { openProblems: [op('SMTP connection refused')] }, 'Resolve: SMTP connection refused'],
  ['unfinished files', { unfinished: files(['a.py', 'b.py', 'c.py']) }, 'Finish and commit changes in a.py and 2 more'],
  ['last intent', { lastIntent: 'add rate limiting' }, 'Continue: add rate limiting'],
  ['nothing', {}, null],
])('next step: %s', (_n, partial, expected) => expect(chooseNextStep(facts(partial))).toBe(expected));
test('buildFacts for rahul scenario', () => {
  const f = buildFacts(root, deps);
  expect(f.branch).toBe('feature/forgot-password');
  expect(f.unfinished.files[0].path).toBe('email_service.py');
  expect(f.nextStep).toBe('Resolve: SMTP connection refused');
});
test('buildFacts works with no events and no git (empty brief, no throw)', ...);
test('factsHash ignores lastActiveAt', ...);
```

- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** `npm run check` → PASS.
- [ ] **Step 5: Commit** `git commit -m "feat(brief): sessions, open problems, claimed-done, next step, facts"`

---

### Task 10: Renderers, `resume` and `note` commands

**Files:**
- Create: `src/render/terminal.ts`, `src/render/markdown.ts`, `src/render/json.ts`, `src/core/time.ts`, `src/cli/commands/resume.ts`, `src/cli/commands/note.ts`; wire in `src/cli/index.ts`
- Test: `tests/render/*.test.ts`, `tests/cli/resume.test.ts`, `tests/cli/note.test.ts`, `tests/core/time.test.ts`

**Interfaces:**
- Produces:
  - `renderTerminal(f: BriefFacts, polished: string | null, opts: { color: boolean }): string`
  - `renderAgentContext(f: BriefFacts, polished: string | null): string` (≤ 4000 chars, exact first/last lines from §1.8; truncates lists before prose)
  - `renderMarkdown(f, polished): string`, `renderJson(f, polished): string`
  - `relativeAgo(iso: string, now: Date): string` ("14h ago", "3d ago", "just now"), `parseSince(s: string, now: Date): Date`
  - `runResume(opts: { cwd: string; project?: string; format: 'terminal' | 'md' | 'json'; polish: boolean }): Promise<{ output: string; exitCode: number }>`
  - `runNote(cwd: string, text: string): Promise<void>` (event `source 'user'`, `kind 'note'`)

`runResume` flow: open repo → `ingest` (budget 1200 ms) → `readWorkingState` → `buildFacts` → cached polish if `factsHash` matches → render → `markBriefShown`. `--polish` additionally runs Task 12's `polishNow` synchronously (with its 60 s timeout).

- [ ] **Step 1: Write failing tests**

```ts
test('terminal render matches golden for rahul scenario', () => {
  expect(renderTerminal(rahulFacts(), null, { color: false })).toMatchFileSnapshot('golden/rahul.txt');
});
test('empty sections are omitted', ...);
test('Notes section renders after Open problems and before Next step', ...); // R-B2
test('Sources line uses the fixed order claude, git, shell, codex; no footer after it', ...); // R-B3
test('"Agent said done, but" section renders first with each contradiction', ...);
test('NO_COLOR disables ANSI', ...);
test('agent context starts and ends with exact lines and is ≤ 4000 chars even with 200 files', ...);
test('json render is valid JSON with facts and polished', ...);
test('relativeAgo / parseSince', ...);
test('resume in a project with no data prints a friendly line and exits 0', async () => {
  expect((await runResume({ cwd: emptyDir, format: 'terminal', polish: false })).output).toContain('No activity recorded yet');
});
test('note appears in next resume output', ...);
```

Golden file `tests/render/golden/rahul.txt` must equal the brief in spec §1.1 (commit subjects without hashes, no footer, fixed Sources order — R-B3). The Rahul facts have no notes and no `Edited N files` line.

- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** `npm run check` → PASS.
- [ ] **Step 5: Commit** `git commit -m "feat(cli): renderers, resume and note commands"`

---

### Task 11: Standup and loose-ends commands

**Files:**
- Create: `src/render/standup.ts`, `src/cli/commands/standup.ts`, `src/brief/loose-ends.ts`, `src/render/loose-ends.ts`, `src/cli/commands/loops.ts`; wire bare `leftoff` to `loops` in `src/cli/index.ts`
- Test: `tests/render/standup.test.ts`, `tests/cli/standup.test.ts`, `tests/brief/loose-ends.test.ts`, `tests/cli/loops.test.ts`

**Interfaces:**
- Produces:
  - `buildStandup(input: { factsByProject: BriefFacts[]; eventsSince: WorkEvent[] }): { yesterday: string[]; today: string[]; blockers: string[] }`
  - `renderStandup(s): string` (exact headings §1.8)
  - `runStandup(opts: { cwd: string; since?: string; all: boolean; copy: boolean }): Promise<{ output: string; exitCode: number }>`
  - `buildLooseEnds(deps: { repo: Repo; config: Config; now: Date; readWorking: typeof readWorkingState }): LooseEnds[]` (rules §1.7)
  - `renderLooseEnds(items: LooseEnds[], now: Date, opts: { color: boolean }): string` (exact format §1.8)
  - `runLoops(opts: { json: boolean }): Promise<{ output: string; exitCode: number }>` — ingest (budget 1200 ms) then build; total budget 1500 ms; a project whose git read times out is shown with `? git status unavailable` instead of being dropped.

Default `since` = start of previous local day when today is Mon–Fri and previous working day is Friday on Mondays. Yesterday = commit subjects per project; a project with **no** commits in the window gets `Worked on <files> with <agent>` instead (R-B4); Today = next steps; Blockers = open problems. Prefix items with project name when `--all`. `--copy` tries `pbcopy`, `wl-copy`, `xclip -selection clipboard` in order; prints `(copied)` or `(clipboard tool not found)`.

- [ ] **Step 1: Write failing tests**

```ts
test('rahul standup', () => {
  expect(renderStandup(buildStandup(...))).toBe(
`Yesterday:
- Built POST /auth/forgot-password endpoint
- Added reset-token migration
Today:
- Resolve: SMTP connection refused
Blockers:
- SMTP connection refused`);
});
test('project without commits gets "Worked on <files> with <agent>"', ...); // R-B4
test('Monday since covers Friday', ...);
test('no activity → Blockers: none and a friendly Yesterday line', ...);
test('--all prefixes project names', ...);
test('loose ends: ordering is claimedDone, open problems, stale, oldest', ...);
test('loose ends: clean projects are omitted; none left → "No loose ends." line', ...);
test('loose ends: render matches golden', () => expect(renderLooseEnds(sample(), now, { color: false })).toMatchFileSnapshot('golden/loose-ends.txt'));
test('loose ends: only maxProjects most recent projects are checked', ...);
test('bare `leftoff` runs loops', ...);
```

- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** `npm run check` → PASS.
- [ ] **Step 5: Commit** `git commit -m "feat(cli): standup and loose-ends commands"`

---

### Task 12: AI polish providers and background summarize

**Files:**
- Create: `src/polish/types.ts`, `src/polish/prompt.ts`, `src/polish/chain.ts`, `src/polish/summarize.ts`, `src/polish/providers/{claude-cli,codex-cli,ollama,anthropic,openai}.ts`, `src/cli/commands/internal.ts`
- Test: `tests/polish/*.test.ts`

**Interfaces:**
- Produces:
  - `interface PolishProvider { name: 'claude-cli' | 'codex-cli' | 'ollama' | 'anthropic' | 'openai'; available(config: Config): Promise<boolean>; polish(prompt: string, timeoutMs: number): Promise<string> }`
  - `buildPolishPrompt(f: BriefFacts): string` (facts JSON ≤ 8000 chars + instruction from §1.9)
  - `validatePolish(text: string): string | null` (trim; null if empty or > 1200 chars)
  - `pickProviders(config: Config): PolishProvider[]` (`off` → []; `auto` → enabled providers in fixed order; single name → that one if enabled)
  - `polishNow(root: string, deps): Promise<{ polished: string | null; provider: string | null }>` — builds facts, skips if cached `factsHash` matches, tries providers in order, saves via `repo.saveBrief`.
  - Background runs use a larger ingest budget: `runInternalSummarize` calls `ingest(ctx, { budgetMs: 20_000 })` (owner decision after Task 8).
  - `spawnBackgroundSummarize(root: string): void` — `spawn(process.execPath, [cliPath, 'internal', 'summarize', '--project', root], { detached: true, stdio: 'ignore', env: { ...process.env, LEFTOFF_INTERNAL: '1' }, cwd: paths().tmp }).unref()`
  - `runInternalSummarize(root: string): Promise<void>` — `acquireLock('summarize:' + root, pid, 120_000)`; if false, return; **always** ingest; `polishNow` only if `polish.provider` is not `off` (R-B1); release.

Provider details (flags verified against Claude Code 2.1.310 and codex-cli 0.163.0 `--help` during the plan review — R-C7; re-check at implementation; required behavior in parentheses):
- `claude-cli`: `claude -p --no-session-persistence --tools "" --output-format text` with the prompt on stdin (single turn, no tools, no transcript written, no interactive prompts), cwd `paths().tmp`, env `LEFTOFF_INTERNAL=1`. Never `--bare` (it skips keychain reads, breaking subscription login on macOS).
- `codex-cli`: `codex exec --ephemeral --skip-git-repo-check -s read-only -` with the prompt on stdin (no session files, read-only sandbox; `--skip-git-repo-check` because the cwd is not a git repo), cwd `paths().tmp`, env `LEFTOFF_INTERNAL=1`.
- `ollama`: `POST http://127.0.0.1:11434/api/generate` `{ model: config.polish.ollamaModel, prompt, stream: false }` → `response`.
- `anthropic` / `openai`: official HTTPS APIs via `fetch`, key from env, model from `config.polish.apiModel`; unavailable if key or model missing.

- [ ] **Step 1: Write failing tests** (providers are injected; no real network)

```ts
test('off → no providers', ...);
test('auto tries next provider when first throws or times out', ...);
test('invalid polish output is discarded', ...);
test('cached polish reused when factsHash unchanged; no provider call', ...);
test('two concurrent summarizes: only one calls the provider', async () => { /* lock */ }); // Review Focus 5
test('claude-cli provider spawns with LEFTOFF_INTERNAL=1 and cwd in LEFTOFF_HOME/tmp', () => { /* spy on spawn */ }); // Review Focus 1
test('claude-cli args include --no-session-persistence and --tools "" and never --bare', ...); // R-C7
test('codex-cli args include --ephemeral, --skip-git-repo-check and -s read-only', ...); // R-C7
test('internal summarize with polish off still ingests and calls no provider', ...); // R-B1
test('prompt contains facts JSON and the no-invention instruction, ≤ 8000 chars', ...);
```

- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** `npm run check` → PASS.
- [ ] **Step 5: Commit** `git commit -m "feat(polish): optional llm polish with background summarize"`

---

### Task 13: Claude Code plugin and hook commands

**Files:**
- Create: `plugin/.claude-plugin/plugin.json`, `plugin/hooks/hooks.json`, `.claude-plugin/marketplace.json`, `src/cli/commands/hook.ts`, `src/install/claude-plugin.ts`, `src/install/shim.ts`
- Test: `tests/cli/hook.test.ts`, `tests/install/claude-plugin.test.ts`, `tests/install/shim.test.ts`, `tests/e2e/hook-cli.e2e.test.ts` (the real-CLI test, moved to e2e because it needs `dist/` — R-A6)

**Interfaces:**
- Consumes: `runResume` pieces (`ingest`, `buildFacts`, `renderAgentContext`), `spawnBackgroundSummarize`, `makeEvent`.
- Produces:
  - `runHook(name: 'claude-session-start' | 'claude-stop' | 'claude-session-end', stdin: string): Promise<{ stdout: string }>` — never throws.
  - `installClaudePlugin(source: string): Promise<'installed' | 'already' | 'claude-not-found' | 'failed'>` (`source` = `GITHUBTANMAY2003/leftoff`, or the local repo path while dogfooding — R-C8), `claudePluginInstalled(): Promise<boolean>`
  - `installShim(nodePath: string, cliPath: string): void` — writes `paths().shim` (mode `0o700`): a POSIX `sh` script that runs `exec '<abs node>' '<abs dist/cli.js>' "$@"`; overwritten on every call (R-C4). `shimStatus(): { exists: boolean; nodePath: string | null; cliPath: string | null; works: boolean }` — `works` = both paths exist and `<shim> --version` exits 0 within 1 s.

`hooks.json` registers: `SessionStart` with matcher `startup|clear|compact` (R-C2) → `claude-session-start` (timeout 5 s); `Stop` → `claude-stop` (timeout 2 s); `SessionEnd` → `claude-session-end` (timeout 2 s; Claude Code gives SessionEnd hooks a shared 1.5 s budget raised to the largest per-hook timeout — R-C3). Each command prefers the shim and falls back to PATH, and always exits 0 (R-C4):

```sh
L="${LEFTOFF_HOME:-$HOME/.leftoff}/bin/leftoff"; if [ -x "$L" ]; then "$L" hook <name>; elif command -v leftoff >/dev/null 2>&1; then leftoff hook <name>; fi; exit 0
```

`.claude-plugin/marketplace.json` names the marketplace `leftoff`; the plugin id is `leftoff@leftoff` (R-C8).

Behavior:
- Any hook with `LEFTOFF_INTERNAL=1` → empty stdout immediately.
- `claude-session-start`: parse stdin JSON (`session_id`, `transcript_path`, `cwd`, `source`); record `session_start` event with `data.transcriptPath`; within 2000 ms budget: ingest (budget 1000 ms), facts, `renderAgentContext`; print `{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"…"}}`. If the project has no prior events, or budget exceeded, print nothing.
- `claude-stop`: record `checkpoint` with transcript path. Nothing printed.
- `claude-session-end`: record `session_end`; **always** `spawnBackgroundSummarize(project)` (it ingests, and polishes only if enabled — R-B1). Nothing printed.
- `installClaudePlugin`: if `claude` on PATH, run `claude plugin marketplace add <source>` then `claude plugin install leftoff@leftoff` (syntax verified with `claude plugin --help` in the plan review; re-check at implementation); on failure print the two commands for the user to run.

- [ ] **Step 1: Write failing tests**

```ts
test('session-start prints valid JSON with exact header line', async () => {
  const out = JSON.parse((await runHook('claude-session-start', stdinFor(rahulRoot))).stdout);
  expect(out.hookSpecificOutput.hookEventName).toBe('SessionStart');
  expect(out.hookSpecificOutput.additionalContext).toMatch(/^## Previous session in this project \(from leftoff\)/);
});
test('garbage stdin → empty stdout, no throw', ...);
test('LEFTOFF_INTERNAL=1 → empty stdout and no events written', ...); // Review Focus 1
test('session-start with no prior data prints nothing', ...);
test('session-start respects 2000 ms budget when ingest is slow', ...);
test('session-end always spawns summarize, also with polish off', ...); // R-B1
test('hooks.json is valid and references the three hooks', () => { /* JSON.parse + shape asserts */ });
test('hook command uses the shim when present, falls back to PATH, exits 0 when neither exists', () => { /* run the command string with sh -c in a temp HOME */ }); // R-C4
test('installShim writes an executable script with absolute node and cli paths; re-run overwrites', ...); // R-C4
test('shimStatus reports works=false when the cli path no longer exists', ...); // R-C4
// tests/e2e/hook-cli.e2e.test.ts:
test('real CLI: `leftoff hook claude-stop` exits 0 with empty stdout on empty stdin', () => { /* execFileSync built dist */ });
```

- [ ] **Step 2: Run** → FAIL. **Step 3: Implement**; also validate with `claude plugin validate plugin` locally if Claude Code is installed. **Step 4: Run** `npm run check` and `npm run test:e2e` → PASS.
- [ ] **Step 4b: Real-session check with the owner (R-C3, Review Focus 1).** With the owner's approval, add the marketplace from the local repo path and install the plugin into their real Claude Code. In one real session confirm: the brief is injected at startup; a polish run with `LEFTOFF_INTERNAL=1` produces no hook output and no events; the SessionEnd background child survives Claude Code exiting (it finishes its ingest). Record the results in the report.
- [ ] **Step 5: Commit** `git commit -m "feat(claude): plugin hooks inject brief and record sessions"`

---

### Task 14: Auto brief on terminal open

**Files:**
- Create: `src/render/auto.ts`, `src/cli/commands/brief-auto.ts`, `src/ingest/background.ts`; modify `shell/leftoff.zsh`, `shell/leftoff.bash`, `shell/leftoff.fish` (`__leftoff_auto`), `src/cli/commands/internal.ts` (add `internal ingest`)
- Test: `tests/cli/brief-auto.test.ts`, `tests/render/auto.test.ts`, `tests/ingest/background.test.ts`

**Interfaces:**
- Produces:
  - `isBriefDue(root: string, repo: Repo, config: Config, now: Date): boolean` — true iff `autoBrief.enabled`, `LEFTOFF_QUIET` unset, `lastActivity(root)` exists and is ≥ `gapHours` before `now`, and `briefShownFor(root)` < that activity.
  - `renderAutoBrief(f: BriefFacts): string` (≤ 8 lines, exact first/last lines §1.8)
  - `runBriefAuto(cwd: string): Promise<string>` — 300 ms total budget; **no foreground ingest** except the git working state; uses stored events only; marks shown; calls `maybeSpawnBackgroundIngest` (never waits for it).
  - `maybeSpawnBackgroundIngest(repo: Repo, now: Date): boolean` — if `cursors('ingest','last_bg')` is missing or ≥ 10 minutes old, writes `now` there and spawns `leftoff internal ingest` detached (`stdio: 'ignore'`, env `LEFTOFF_INTERNAL=1`, cwd `paths().tmp`, `unref()`); returns whether it spawned (R-D3).
  - `runInternalIngest(): Promise<void>` — `acquireLock('ingest:bg', pid, 120_000)`; if false, return; `ingest(ctx, { budgetMs: 20_000 })` (all projects; larger budget for background runs — owner decision after Task 8); release.

Shell wiring: `__leftoff_auto` runs `leftoff brief --auto` on the first prompt of an interactive shell and on directory change into a different project (compare `git rev-parse --show-toplevel` output cached in a shell variable; fall back to `$PWD`). Output goes to the terminal (stderr is discarded).

- [ ] **Step 1: Write failing tests**

```ts
test('due after 4h gap, not due twice', ...);
test('not due when LEFTOFF_QUIET=1 or autoBrief.enabled=false', ...);
test('auto brief ≤ 8 lines with exact first and last lines', ...);
test('runBriefAuto returns "" when over budget', ...);
test('background ingest spawns at most once every 10 minutes; brief output does not wait for it', ...); // R-D3
test('two concurrent internal ingests: only one runs (lock ingest:bg)', ...); // R-D3
test('zsh: cd into project prints brief once', () => { /* zsh -fic with scripted cd; skip if zsh absent */ });
```

- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** `npm run check` → PASS.
- [ ] **Step 5: Commit** `git commit -m "feat: automatic brief on terminal open"`

---

### Task 15: setup, doctor, status, forget, config, uninstall

**Files:**
- Create: `src/cli/commands/{setup,doctor,status,forget,config,uninstall}.ts`
- Test: `tests/cli/{setup,doctor,status,forget,config,uninstall}.test.ts`

**Interfaces:**
- Consumes: `installShellScripts`, `installedShellScriptVersion`, `installShellHook`, `removeShellHook`, `installShim`, `shimStatus`, `installClaudePlugin`, `claudePluginInstalled`, `pickProviders`, `Repo`, `readRecentErrors`.
- Produces:
  - `runSetup(io: Prompter, env: SetupEnv): Promise<SetupResult>` — `Prompter` = `{ confirm(q: string, def: boolean): Promise<boolean>; choose<T extends string>(q: string, options: T[], def: T): Promise<T>; input(q: string, def?: string): Promise<string> }` (implemented with `node:readline/promises`; tests inject a scripted prompter). `SetupEnv` = `{ home: string; shell: string; hasClaude: boolean; hasCodex: boolean; hasOllama: boolean }`.
  - `runDoctor(): Promise<{ checks: { name: string; ok: boolean; hint?: string }[]; exitCode: 0 | 1 }>`
  - `runStatus(): Promise<string>`, `runForget(opts: { project?: string; all: boolean; yes: boolean }, io: Prompter): Promise<string>`, `runConfig(args: string[]): Promise<{ output: string; exitCode: number }>`, `runUninstall(io: Prompter): Promise<string>`

Setup steps, in order: (1) create home; (1b) write the CLI shim with `installShim(process.execPath, <absolute path of the running dist/cli.js>)` and copy the shell scripts with `installShellScripts` — both on every run, so they always point at the current install (R-C4, R-B8); (2) detect shells from `$SHELL` + existing rc files, offer to install hook into `~/.zshrc` / `~/.bashrc` / `~/.config/fish/config.fish`; (3) if Claude Code found, offer plugin install; (4) note Codex logs found or not; (5) polish: offer `off` (default), `claude-cli`, `codex-cli`, `ollama` (ask model), `anthropic`/`openai` (ask model, require env key), explaining in one line which ones send data off the machine; (6) run a first full catch-up ingest with a generous budget (`ingest(ctx, { budgetMs: 60_000 })`, owner decision after Task 8) and print a one-line progress summary, e.g. `Read 12 Claude sessions, 3 Codex sessions, 840 commands, 25 commits`; (7) print a summary and "Open a new terminal to start". Re-running setup shows current choices as defaults.

Doctor checks (each with a fix hint): Node ≥ 22.15; platform supported; home dir permissions; DB opens and `user_version` current; config valid; CLI shim exists and `shimStatus().works` (hint: "Run leftoff setup" — R-C4); each rc hook block present; copied shell scripts present and their `# leftoff <version>` header matches the running CLI version, warning otherwise (R-B8); shell log received a line in the last 7 days (if hook installed); Claude plugin installed and a `session_start` event in the last 7 days (if Claude found); Codex sessions readable; Codex storage-format check (owner decision after Task 7): if Codex is installed and `$CODEX_HOME` shows recent activity (any file there, e.g. `thread_history_*.sqlite`, modified in the last 7 days — mtimes only, contents never read) but no `rollout-*.jsonl` / `.jsonl.zst` file is newer than 7 days, warn "Codex may have changed its storage format; leftoff may be missing Codex sessions"; malformed-line counts from the last ingest report in `cursors('ingest','last_report')` (R-B10); polish provider available (if not `off`); last 5 errors from the log.

- [ ] **Step 1: Write failing tests**

```ts
test('setup with scripted answers installs zsh hook and writes config', ...);
test('setup is idempotent', ...);
test('setup runs a catch-up ingest with a 60 s budget and prints one progress line', ...); // owner decision after Task 8
test('setup writes the shim and copies shell scripts on every run', ...); // R-C4, R-B8
test('doctor flags missing shell hook with hint "Run leftoff setup"', ...);
test('doctor fails when the shim is missing or points at a CLI that no longer exists', ...); // R-C4
test('doctor warns when copied shell scripts are from an older version', ...); // R-B8
test('doctor warns when Codex is active but no rollout file is newer than 7 days', ...); // owner decision after Task 7
test('doctor exit code 1 when any check fails', ...);
test('forget --project removes only that project', ...);
test('forget output and --help say that read positions (file paths and offsets, no content) are kept', ...);
test('config set/get/list round-trip and rejects unknown keys', ...);
test('uninstall removes rc blocks and keeps data unless confirmed', ...);
```

- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** `npm run check` → PASS.
- [ ] **Step 5: Commit** `git commit -m "feat(cli): setup, doctor, status, forget, config, uninstall"`

---

### Task 16: End-to-end and performance tests

**Files:**
- Create: `tests/e2e/rahul.e2e.test.ts`, `tests/e2e/perf.e2e.test.ts`, `tests/e2e/helpers.ts`
- CI already runs `npm run test:e2e` after `build` on both OSes since Task 1 (R-A6); no workflow change expected.

**Interfaces:**
- Consumes: built CLI at `dist/cli.js`; fixtures from Tasks 4, 6, 7.

- [ ] **Step 1: Write the e2e tests** (spawn the built CLI with `LEFTOFF_HOME` and `HOME` pointed at temp dirs)

```ts
test('rahul scenario end to end', () => {
  // temp git repo on branch feature/forgot-password with commit "Added reset-token migration"
  // copy claude fixture (SMTP failure + two attempts) into HOME/.claude/projects/...
  // append shell lines; leave email_service.py modified
  const out = run(['resume'], { cwd: repo });
  expect(out).toContain('Where you left off — ');
  expect(out).toContain('feature/forgot-password');
  expect(out).toContain('email_service.py');
  expect(out).toContain('SMTP connection refused');
  expect(out).toContain('→ Resolve: SMTP connection refused');
});
test('hook session-start returns context for the same scenario', ...);
test('standup for the same scenario matches Task 11 golden', ...);
test('bare `leftoff` lists the scenario project with its open problem and uncommitted file', ...);
test('a collector source missing entirely (no ~/.codex) still gives a brief with "codex –"', ...);
test('secrets planted in fixture never appear in the sqlite file', () => {
  expect(readFileSync(join(home, 'leftoff.db')).includes('hunter2')).toBe(false);
}); // Review Focus 3
```

```ts
test('resume p95 < 300 ms with no new data (20 runs)', ...);
test('ingest of 50 MB new transcript < 1500 ms', ...);
test('shell hook overhead < 5 ms per command (zsh, 200 iterations, median)', ...);
```

- [ ] **Step 2: Run** `npm run test:e2e` → fix anything failing in the owning module (with a regression test there).
- [ ] **Step 3: Commit** `git commit -m "test: end-to-end scenario and performance budgets"`

---

### Task 17: Dogfooding and hardening (private use before release)

**Goal:** prove leftoff works on real projects before anyone else depends on it (D12). No new features in this task; only fixes, each with a regression test in the owning module.

**Files:**
- Create: `docs/dogfood-log.md`, `docs/dogfood-checklist.md`
- Modify: whatever modules the bugs live in (plus their tests)

- [ ] **Step 1: Install locally (owner approves).** `npm run build && npm link` makes the `leftoff` command run the local build. The owner runs `leftoff setup` on their real machine, choosing their shells and the Claude Code plugin (marketplace added from the local repo path — R-C8). The shim then points at the repo's `dist/cli.js`. Record the exact steps and any friction in `docs/dogfood-log.md`.
- [ ] **Step 2: Daily use for at least 7 days** on at least 2 real projects with real Claude Code (and Codex if enabled) work. Each day the owner adds an entry to `docs/dogfood-log.md`: date; what `leftoff`, the auto brief and `leftoff resume` showed; correct / wrong / missing items; false "claimed done" alarms; anything slow; any error output.
- [ ] **Step 3: Daily health checks** (put these commands in `docs/dogfood-checklist.md`): `leftoff doctor` exits 0; `~/.leftoff/logs/leftoff.log` has no new errors; `time leftoff resume` and `time leftoff` are within §1.12 budgets; a secret scan of the database finds nothing (`sqlite3 ~/.leftoff/leftoff.db .dump | grep -E "ghp_|sk-|AKIA|BEGIN .*PRIVATE KEY|password="` returns no lines).
- [ ] **Step 4: Fix loop.** For every problem: reproduce it in a failing test in the owning module, fix it, run `npm run check`, commit `fix(<module>): <what>`, rebuild (`npm run build`; `npm link` picks it up), and note the fix in the log.
- [ ] **Step 5: Private beta (owner publishes).** Bump to `1.0.0-beta.1`; the owner runs `npm publish --tag beta` with their own login. Two or three trusted developers install with `npm i -g @leftoff-dev/cli@beta && leftoff setup` and report problems as GitHub issues. The `latest` tag stays on the placeholder, so normal installs are unaffected.
- [ ] **Step 6: Exit criteria — all must hold before Task 18:**
  - 7 consecutive days with no crash, no hook error shown in Claude Code, and no error in `leftoff.log`
  - the brief judged correct on at least 90% of logged days, and no false "claimed done" alarm in the last 3 days
  - secret scan clean every day
  - all §1.12 performance budgets met on the owner's real data
  - every bug found has a regression test and is fixed; every beta issue is fixed or explicitly deferred in `CHANGELOG.md`
  - `leftoff uninstall` tested once on the owner's machine and on a beta tester's, then reinstalled
- [ ] **Step 7: Commit** `git commit -m "chore: dogfooding log and fixes"`.

---

### Task 18: Packaging, docs and release

**Files:**
- Create: `README.md`, `CONTRIBUTING.md`, `LICENSE` (MIT), `CHANGELOG.md`, `docs/adding-a-collector.md`, `.github/workflows/release.yml`, `demo/demo.tape`
- Modify: `package.json` (final name, `files`, `repository`, `keywords`), `plugin/.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json` (repo URLs)

- [ ] **Step 1: Confirm package identity.** `package.json` `name` is `@leftoff-dev/cli`, `bin` is `{"leftoff": "dist/cli.js"}`, `publishConfig.access` is `public`, `repository` points at `github.com/GITHUBTANMAY2003/leftoff`. Bump from the placeholder `0.0.1` to `1.0.0`. Plugin and marketplace manifests use the same repo URL.
- [ ] **Step 2: README** — the one-line pitch and positioning from §1.1, a short "How leftoff differs from agent memory" section (Claude Code recap/auto memory, Codex Memories, claude-mem: they recall knowledge for the agent; leftoff tracks unfinished state for you, from ground truth, across tools), a demo GIF (record with `vhs demo/demo.tape` showing: close terminal → reopen → auto brief → `leftoff standup`), install (`npm i -g @leftoff-dev/cli && leftoff setup`), what is recorded and where (commands typed with a leading space are never recorded — use that for anything sensitive), privacy section (local only, redaction, `forget` — removes all events and briefs but keeps read positions, i.e. file paths and offsets with no content, so forgotten history isn't re-imported — polish providers that leave the machine), commands table from spec §1.10, troubleshooting = `leftoff doctor`, uninstall.
- [ ] **Step 3: CONTRIBUTING + docs/adding-a-collector.md** — the `Collector` interface, fixture capture procedure from Task 6, test checklist (malformed lines, partial lines, dedupe, budget).
- [ ] **Step 4: release.yml** — on tag `v*`: `npm ci && npm run check && npm run build && npm run test:e2e`, then publish using **npm trusted publishing** (GitHub Actions OIDC, `id-token: write` permission, `npm publish --provenance --access public`; no stored token), and create a GitHub Release with the CHANGELOG section. The owner configures the trusted publisher on npmjs.com. Until that is set up, the owner publishes manually with `npm publish --access public`.
- [ ] **Step 5: Fresh-machine check** (Docker is only a clean Linux test machine here, not a shipping method — D13) — in a clean Docker `node:22` container and on a macOS machine: install from the packed tarball (`npm pack`), run `leftoff setup`, use Claude Code for 5 minutes, open a new terminal after setting `autoBrief.gapHours 0`, confirm the brief appears and `leftoff doctor` is all green. Record results in the PR.
- [ ] **Step 6: Commit** `git commit -m "docs: readme, contributing, release workflow"`. The owner creates and pushes tag `v1.0.0` and publishes.

---

## Self-review notes

- Spec coverage: §1.2 D1–D13 and §1.3 P1–P12 each map to tasks (D3/D4 → 4–7; D6 → 12; D7 → 10, 13, 14; D9 → 2; D10 → 8, 13, 15; D11 → 9, 10, 11, 18; D12 → 17; D13 → 18; P7 → 14; P10 → 3, 4, 12, 15; P11 → 10; P12 → 13, 18).
- Interfaces: `Collector.collect` returns `{ events, pendingCursors, warnings }` everywhere (Tasks 4–8); optional `Collector.afterCommit` runs only after a successful commit (R-B5).
- Plan review decisions (R-*) from `docs/reports/task-00-plan-review.md` are listed after §1.3 and applied in the sections and tasks named there. `BriefFacts`/`OpenProblem`/`ClaimedDone`/`LooseEnds` defined once in §1.7 and used by Tasks 9–14.
- Review Focus items each have a named test in their owning task.
