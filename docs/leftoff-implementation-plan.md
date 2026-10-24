# leftoff — Design Spec and Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Read **Part 1 (Spec)** in full before starting any task — every task argues from it.

**Goal:** A free, open-source, local CLI that remembers what a developer (and their AI coding agent) was doing in each project, and gives it back as a "resume brief" and an auto-written standup when they return.

**Architecture:** Event-driven, no daemon. Tiny capture hooks (Claude Code plugin hooks, a pure-shell terminal hook) record that something happened; collectors read git, shell, Claude Code and Codex logs incrementally into one local SQLite file; a brief builder turns events into deterministic facts, optionally polished by an LLM the user already has.

**Package:** `@leftoff-dev/cli` (command `leftoff`).

**Tech Stack:** Node.js ≥ 22, TypeScript (ESM, strict), `better-sqlite3`, `commander`, `fzstd`, `tsup` (build), `vitest` (tests), `eslint` + `prettier`, GitHub Actions, npm.

**Spec:** Part 1 of this document.

---

# Part 1 — Design Spec

## 1.1 The problem and the pitch

Developers lose time every time they come back to a project: what was I doing, which branch, what was half-finished, which fixes did I (or my agent) already try? Git shows commits, not context. Today most code is written by AI agents (Claude Code, Codex), so most of that context lives in agent sessions that nobody re-reads.

**One-line pitch:** "It remembers what you were doing, so you don't have to — close your laptop mid-task, come back days later, and pick up in two minutes. Your AI agent picks up too."

**Example the product must nail:** Rahul builds a "forgot password" feature with Claude Code on Tuesday evening, hits `SMTP connection refused`, the agent tries two fixes that fail, he logs off with uncommitted work. Wednesday morning, opening a terminal in the repo prints:

```
Where you left off — myapp (feature/forgot-password) · last active 14h ago

Done
  • Built POST /auth/forgot-password endpoint
  • Added reset-token migration (commit a1b2c3d)

Unfinished
  • email_service.py (modified, uncommitted)

Open problems
  ✗ SMTP connection refused
    tried: changed port to 587 · disabled TLS

Next step
  → Resolve: SMTP connection refused

Sources: claude ✓  git ✓  shell ✓  codex –
Run `leftoff resume` for full details · `leftoff standup` for your standup
```

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

## 1.3 Decisions made while writing this plan (product owner: review these)

| # | Decision | Choice |
|---|---|---|
| P1 | Name | Product and command: **`leftoff`**. npm package: **`@leftoff-dev/cli`** (plain `leftoff` is blocked by npm as too similar to `liftoff`; the `leftoff` org name is unavailable). Placeholder `0.0.1` already published under the `leftoff-dev` npm org. GitHub: `github.com/GITHUBTANMAY2003/leftoff` (may move to a `leftoff-dev` GitHub org later; GitHub redirects). |
| P2 | Platforms | macOS and Linux (incl. WSL). Native Windows not supported at launch; `doctor` says so. |
| P3 | Shells | zsh, bash, fish. |
| P4 | Data location | `~/.leftoff/` (override with env `LEFTOFF_HOME`). Directory mode `700`, files `600`. |
| P5 | Project identity | Git top-level directory (`git rev-parse --show-toplevel`); non-git folders use their real path. |
| P6 | Work session | Consecutive events in one project with no gap ≥ `sessionGapMinutes` (default **45**). |
| P7 | Auto-brief trigger | On shell start or `cd` into a project, print a compact brief if the project's last activity was ≥ `autoBrief.gapHours` (default **4**) ago **and** no brief has been shown since that activity. Disable with config or env `LEFTOFF_QUIET=1`. |
| P8 | Claude Code hooks | `SessionStart` (matcher `startup|clear|compact`) injects the brief; `Stop` records a checkpoint; `SessionEnd` records the end and starts a short detached background summarize. |
| P9 | Retention | Events older than `retentionDays` (default **30**) are pruned. |
| P10 | Privacy | Secrets are redacted **before** storage. Commands typed with a leading space are never recorded. Projects/commands can be ignored by config. `leftoff forget` deletes data. Polish providers that send data off-machine are only used if the user enabled them in `setup`. Default polish without setup: `off`. |
| P11 | Manual notes | `leftoff note "text"` adds a note to the current project's timeline; notes always appear in the brief. |
| P12 | Distribution | npm (`npm i -g @leftoff-dev/cli && leftoff setup`), Claude Code plugin + marketplace manifest in the same GitHub repo, MIT license. |

## 1.4 Components

```
CAPTURE (tiny, never fails)   INGEST + STORE                   OUTPUT
Claude Code plugin hooks ──┐  Collectors (git, shell,          leftoff resume
Shell hook (zsh/bash/fish) ├─> claude, codex) ─> SQLite  ─>    auto brief on terminal open
Read on demand:            │   (cursors: read only new data)   brief injected into Claude Code
  git, transcripts, codex ─┘   Brief builder: facts → optional AI polish   leftoff standup / doctor
```

1. **Capture** — records only that something happened. Must never crash, never print to stdout unless that output is the contract, never slow the user down.
   - Shell hook: pure shell, appends one TSV line per command to `~/.leftoff/shell/shell.log`. No Node process per command.
   - Claude Code plugin hooks call `leftoff hook <name>`.
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
| shell | `~/.leftoff/shell/shell.log` from cursor; processed bytes are removed afterwards so raw lines don't linger | `command`, `command_failed` (exit ≠ 0) |
| claude | Claude Code transcripts (`~/.claude/projects/**/*.jsonl`, plus paths reported by hooks), byte-offset cursor per file | `user_prompt`, `agent_message`, `file_edit` (Edit/Write/MultiEdit tool uses), `command` (Bash tool), `command_failed`/`tool_error` (tool results marked as errors), `test_failed`, `session_start`/`session_end` |
| codex | `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` (byte-offset cursor) and `*.jsonl.zst` (re-read only when size/mtime change; skipped above `codex.maxCompressedMb`, default 200) | same kinds as claude |

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
  notes: string[];
  nextStep: string | null;
  sources: { name: Source; status: 'ok' | 'not_found' | 'error'; detail?: string }[];
}
interface OpenProblem { error: string; source: Source; firstSeen: string; attempts: string[] }
```

Rules:
- **Window:** the most recent work session for the project; if it has fewer than 3 events, include the previous session too.
- **Open problem:** a `command_failed` / `tool_error` / `test_failed` event whose normalized command (whitespace collapsed, leading env assignments removed) is **not** followed later in the window by a successful `command` with the same normalized command. `attempts` = summaries of `file_edit` and `command` events after the failure, newest last, max 5, deduplicated.
- **Next step (first match wins):** newest note starting with `next:` → `Resolve: <newest open problem error>` → `Finish and commit changes in <first unfinished file>` (+ ` and N more`) → `Continue: <lastIntent>` → `null`.
- **Polish never replaces facts.** A polished paragraph is shown above the facts; facts are always shown.

## 1.8 Output formats (exact copy)

- Terminal brief: headings exactly `Where you left off`, `Done`, `Unfinished`, `Open problems`, `Next step`, then the `Sources:` line (`✓` ok, `–` not_found, `!` error). Empty sections are omitted. Respect `NO_COLOR`.
- Auto brief (terminal open): first line `Where you left off — <name> (<branch>) · last active <gap>`, at most 6 more lines (unfinished count, top open problem, next step), last line `Run \`leftoff resume\` for details`.
- Agent context (Claude Code `additionalContext`): Markdown starting with `## Previous session in this project (from leftoff)`, ending with the line `This is an automatic summary of earlier work. Verify against the code before relying on it.` Max **4000** characters.
- Standup: three sections `Yesterday:`, `Today:`, `Blockers:` (`Blockers: none` if empty).

## 1.9 AI polish

- Providers: `claude-cli`, `codex-cli`, `ollama`, `anthropic`, `openai`. Config `polish.provider`: `off` (default before setup) | `auto` (try enabled providers in the order listed) | one provider name. `polish.enabled` lists which providers the user allowed in setup.
- Polish only runs in the **background** (after `SessionEnd`, or `leftoff resume --polish`). Foreground commands use a cached polished summary only if its `facts_hash` matches current facts; otherwise they show facts only. Never block the user on an LLM.
- Input: the `BriefFacts` JSON (≤ 8000 chars). Instruction: rewrite into ≤ 4 sentences, add nothing not present in the facts. Output rejected if empty or > 1200 chars. Timeout 60 s.
- **Recursion guard:** provider subprocesses run with env `LEFTOFF_INTERNAL=1` and cwd `~/.leftoff/tmp`. All hooks exit immediately when `LEFTOFF_INTERNAL=1`; all collectors ignore events whose project is inside `LEFTOFF_HOME`.
- API providers need the user's key from env (`ANTHROPIC_API_KEY` / `OPENAI_API_KEY`) and a model name chosen in setup (`polish.apiModel`). No model id is hardcoded.

## 1.10 Commands

| Command | Purpose |
|---|---|
| `leftoff setup` | Interactive: detect shells and agents, install shell hook block into rc files, install the Claude Code plugin, choose polish provider. Idempotent. |
| `leftoff resume [--project <path>] [--json\|--md] [--polish]` | Full brief for the project of cwd (or `--project`). |
| `leftoff standup [--since <yesterday\|today\|Nh\|YYYY-MM-DD>] [--all] [--copy]` | Standup text; `--all` covers every project; `--copy` uses pbcopy / wl-copy / xclip if present. |
| `leftoff note "<text>"` | Add a note to the current project. |
| `leftoff status` | Tracked projects, last ingest per collector, event counts. |
| `leftoff doctor` | Health checks with a fix hint for each failure. Exit code 1 if any check fails. |
| `leftoff forget (--project <path> \| --all)` | Delete stored data (asks for confirmation unless `--yes`). |
| `leftoff config (get <key> \| set <key> <value> \| list)` | Read/write config. |
| `leftoff uninstall` | Remove rc blocks, print the plugin uninstall command, optionally delete data. |
| hidden: `leftoff hook <claude-session-start\|claude-stop\|claude-session-end>`, `leftoff brief --auto`, `leftoff internal summarize --project <path>` | Used by hooks. |

## 1.11 Reliability rules (apply everywhere)

- Hooks (`leftoff hook …`, `leftoff brief --auto`, shell scripts): **always exit 0**, never write anything to stdout except their contract output, finish within their budget (session-start 2 s, others 500 ms, `brief --auto` 300 ms) or give up silently.
- Every error is appended to `~/.leftoff/logs/leftoff.log` (rotated at 1 MB, keep 2 files). `doctor` shows the last 5.
- One failing collector never prevents a brief. Its status shows as `!` and in `doctor`.
- SQLite: WAL, `busy_timeout = 2000`, schema versioned with `PRAGMA user_version`. If the DB fails to open as a valid database, move it to `leftoff.db.corrupt-<timestamp>`, create a fresh one, log it.
- Only one background summarize per project at a time (lease in `locks`, 120 s expiry).

## 1.12 Success criteria

- Install + setup in under 5 minutes on a fresh macOS/Linux machine with Node 22.
- `leftoff resume` p95 < 300 ms with no new data to ingest; < 1.5 s with 50 MB of new agent logs.
- Shell hook adds < 5 ms per command.
- Hooks never make Claude Code wait more than their budget and never surface an error to the agent.
- The brief for the §1.1 scenario contains: the branch, the uncommitted file, the open problem with both attempts, and next step `Resolve: SMTP connection refused`.

---

# Part 2 — Implementation Plan

## Global Constraints

- Node `>=22`; `"type": "module"`; TypeScript `strict: true`; target ES2022.
- Runtime dependencies limited to: `better-sqlite3`, `commander`, `fzstd`. Anything else needs a written reason in the PR.
- Data dir `~/.leftoff` (env `LEFTOFF_HOME` overrides); dir mode `0o700`, files `0o600`.
- Defaults: `sessionGapMinutes 45`, `autoBrief.gapHours 4`, `retentionDays 30`, `ingest.maxBytesPerFilePerRun 52428800`, `codex.maxCompressedMb 200`, `polish.provider "off"`.
- Limits: event `summary` ≤ 300 chars, `data` ≤ 4096 bytes serialized, agent context ≤ 4000 chars, polish input ≤ 8000 chars, polish output ≤ 1200 chars.
- Hook budgets: session-start 2000 ms, stop/session-end 500 ms, `brief --auto` 300 ms. Hooks always exit 0.
- Env flags: `LEFTOFF_INTERNAL=1` (skip all hooks), `LEFTOFF_QUIET=1` (no auto brief), `NO_COLOR` respected.
- All timestamps stored as ISO 8601 UTC; displayed in local time.
- Exact output copy from spec §1.8.
- Every task ends with `npm run check` (= `tsc --noEmit && eslint . && vitest run`) passing, then a commit.

## Review Focus

1. **Recursion through polish** — running `claude -p` for polish fires our own hooks and writes a new transcript; expected: no hook output, no events from that session. Test in Task 12 and Task 13.
2. **Hostile agent logs** — multi-GB files, a partial last line still being written, malformed JSON lines, unknown line types after an agent update; expected: ingest stays within budget, never crashes, cursor never skips the partial line. Tests in Tasks 6, 7, 8.
3. **Secrets in commands and transcripts** — tokens, passwords, private keys typed in commands or echoed in tool output; expected: never stored unredacted; raw shell log bytes removed after ingest; leading-space commands never recorded. Tests in Tasks 3, 4, 8.
4. **Unusual project layouts** — non-git folder, repo with no commits, detached HEAD, nested repo, git worktree, path with spaces; expected: correct project root and a brief without crashing. Tests in Tasks 3, 5.
5. **Concurrency** — two Claude sessions and the shell writing while `resume` reads; two `SessionEnd`s starting summarize at once; expected: no "database is locked" crash, one summarize runs. Tests in Tasks 2, 12.

---

## File structure

```
package.json, tsconfig.json, tsup.config.ts, vitest.config.ts, eslint.config.js, .prettierrc
src/
  cli/index.ts                      commander wiring, global error handler
  cli/commands/resume.ts note.ts standup.ts status.ts doctor.ts setup.ts
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
  collectors/git.ts shell.ts claude.ts codex.ts registry.ts
  collectors/jsonl-reader.ts        incremental JSONL reading (plain + zst)
  ingest/ingest.ts                  run collectors with isolation, pruning
  brief/sessions.ts facts.ts next-step.ts hash.ts
  render/terminal.ts markdown.ts json.ts standup.ts auto.ts
  polish/types.ts chain.ts summarize.ts prompt.ts
  polish/providers/claude-cli.ts codex-cli.ts ollama.ts anthropic.ts openai.ts
  install/shell-rc.ts claude-plugin.ts
shell/leftoff.zsh leftoff.bash leftoff.fish
plugin/.claude-plugin/plugin.json
plugin/hooks/hooks.json
.claude-plugin/marketplace.json
.github/workflows/ci.yml release.yml
tests/  (mirrors src/), tests/fixtures/{claude,codex,shell}/, tests/e2e/
README.md CONTRIBUTING.md LICENSE CHANGELOG.md docs/adding-a-collector.md
```

---

### Task 1: Project scaffold, paths, config, logger

**Files:**
- Create: `package.json`, `tsconfig.json`, `tsup.config.ts`, `vitest.config.ts`, `eslint.config.js`, `.prettierrc`, `.github/workflows/ci.yml`, `src/core/paths.ts`, `src/core/config.ts`, `src/core/logger.ts`, `src/core/budget.ts`, `src/cli/index.ts`
- Test: `tests/core/paths.test.ts`, `tests/core/config.test.ts`, `tests/core/logger.test.ts`, `tests/core/budget.test.ts`

**Interfaces:**
- Produces:
  - `paths(): { home, db, config, shellLog, logDir, logFile, tmp }` (all absolute; honors `LEFTOFF_HOME`)
  - `ensureHome(): void` (creates dirs with `0o700`)
  - `type Config` (shape from spec §1.9/§1.3), `DEFAULT_CONFIG`, `loadConfig(): Config`, `saveConfig(c: Config): void`, `getConfigValue(key: string)`, `setConfigValue(key: string, raw: string): Config`
  - `logError(scope: string, err: unknown): void`, `readRecentErrors(n: number): string[]`
  - `withBudget<T>(p: Promise<T>, ms: number): Promise<T | undefined>`

- [ ] **Step 1: Scaffold.** `package.json` with `"name": "@leftoff-dev/cli"`, `"bin": {"leftoff": "dist/cli.js"}`, `"publishConfig": {"access": "public"}`, `"engines": {"node": ">=22"}`, scripts `build` (tsup), `test` (vitest run), `check` (`tsc --noEmit && eslint . && vitest run`). CI workflow runs `npm ci && npm run check && npm run build` on `ubuntu-latest` and `macos-latest` × Node `22` and `24`.

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
test('log rotates at 1 MB keeping 2 files', () => { /* write >1MB, expect leftoff.log and leftoff.log.1 only */ });
test('withBudget returns undefined after timeout', async () => {
  expect(await withBudget(new Promise(r => setTimeout(() => r(1), 50)), 10)).toBeUndefined();
});
```

- [ ] **Step 3: Run** `npx vitest run tests/core` → FAIL (modules missing).
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
    - `insertEvents(events: WorkEvent[]): number` (INSERT OR IGNORE on `dedupe_key`; returns inserted count; one transaction)
    - `eventsForProject(root: string, sinceIso: string): WorkEvent[]` (ts ascending)
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

- [ ] **Step 2: Run** `npx vitest run tests/store` → FAIL.
- [ ] **Step 3: Implement** `db.ts`, `migrations.ts` (array of SQL strings indexed by version; apply those above `user_version` in a transaction), `repo.ts`. `data` stored as JSON text. Set file mode `0o600` after creation.
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

Redaction patterns (replace secret part with `[REDACTED]`): AWS access keys `AKIA[0-9A-Z]{16}`, GitHub `gh[pousr]_[A-Za-z0-9]{36,}` and `github_pat_[A-Za-z0-9_]{20,}`, `sk-ant-[A-Za-z0-9_-]{20,}`, `sk-[A-Za-z0-9_-]{20,}`, Slack `xox[abprs]-[A-Za-z0-9-]{10,}`, JWTs `eyJ[\w-]+\.[\w-]+\.[\w-]+`, PEM blocks `-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----`, URL credentials `://user:pass@`, `Bearer <token>`, assignments/flags whose name matches `/(pass(word)?|secret|token|api[_-]?key|auth)/i` (`KEY=value`, `--password value`, `--token=value`, `"password": "value"`).

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
```

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
  - `interface CollectContext { repo: Repo; config: Config; now: Date; projectFilter?: string }`
  - `interface Collector { name: Source; isAvailable(ctx: CollectContext): Promise<boolean>; collect(ctx: CollectContext): Promise<CollectResult> }`
  - `interface CollectResult { events: WorkEvent[]; pendingCursors: { key: string; value: string }[]; warnings: string[] }` — collectors only *read* cursors (`ctx.repo.getCursor(name, key)`); ingest (Task 8) inserts the events and commits `pendingCursors` in one transaction.
  - `shellCollector: Collector`
  - `installShellHook(shell: 'zsh' | 'bash' | 'fish', rcPath: string, scriptPath: string): 'installed' | 'already'`, `removeShellHook(rcPath: string): boolean`

Shell log line format (one line per command, tab-separated): `ts_epoch_ms \t exit_code \t duration_ms \t pid \t cwd \t command` with tabs/newlines in `cwd`/`command` replaced by spaces. Scripts:
- zsh: `preexec` stores start time + command; `precmd` appends the line; `chpwd` and first prompt call `leftoff brief --auto` (Task 14 wires this; leave a function `__leftoff_auto` that is a no-op if `leftoff` is missing).
- bash: `PROMPT_COMMAND` prepended (preserve existing), uses `history 1`; record only if the history number changed. **Must work on bash 3.2** (the default `/bin/bash` on macOS): no associative arrays, no `PS0`, no `${var,,}`, no `mapfile`; `PROMPT_COMMAND` may be a string, not an array. Test against `/bin/bash` on macOS CI.
- fish: `fish_preexec` / `fish_postexec` events.
- All: skip if command starts with a space, if `LEFTOFF_INTERNAL=1`, or if the log dir is missing. Never print. File created with `umask 077`.

Collector: reads `shell.log` from byte cursor, splits complete lines only, emits `command` (exit 0) / `command_failed` (exit ≠ 0) with `summary` = redacted command (failed: `` `cmd` exited 1 ``), `sessionRef` = `shell:<pid>`, `data` = `{ exitCode, durationMs, cwd }`. Lines whose cwd matches `config.ignore.projects` globs, commands matching `config.ignore.commands`, or inside `LEFTOFF_HOME` are dropped. After a successful ingest commit, the processed prefix of the file is removed (rewrite remaining bytes to a temp file + rename) and the cursor reset to 0.

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
test.each(['bash', 'fish'])('%s hook records a command line', ...);
test('leading-space command is not recorded', ...);
test('installShellHook is idempotent and removable', () => {
  expect(installShellHook('zsh', rc, script)).toBe('installed');
  expect(installShellHook('zsh', rc, script)).toBe('already');
  expect(readFileSync(rc, 'utf8')).toContain('# >>> leftoff >>>');
  expect(removeShellHook(rc)).toBe(true);
  expect(readFileSync(rc, 'utf8')).not.toContain('leftoff');
});
```

- [ ] **Step 2: Run** → FAIL. **Step 3: Implement** scripts, collector, rc installer (block delimited by `# >>> leftoff >>>` / `# <<< leftoff <<<`, sourcing the installed script path). **Step 4: Run** `npm run check` → PASS.
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
test('reader handles a 600 MB synthetic file within 3 s for the first 50 MB', ...); // perf, mark .skipIf(process.env.CI_FAST)
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
```

- [ ] **Step 3: Run** → FAIL. **Step 4: Implement.**
  - Discovery: union of transcript paths from `session_start`/`checkpoint`/`session_end` hook events and files under `~/.claude/projects/` with mtime newer than the newest stored claude cursor update minus 1 day.
  - Mapping (from the fixtures): user text messages → `user_prompt`; assistant text → `agent_message` (keep last 300 chars); tool uses named `Edit`/`Write`/`MultiEdit`/`NotebookEdit` → `file_edit` with `data.path`; `Bash` → `command` with the command string; a tool result flagged as an error → `command_failed` (if its tool use was Bash) else `tool_error`; a Bash result whose output matches `/\b(\d+ (failed|failing)|FAIL\b|AssertionError|Tests?:\s+\d+ failed)/` → also `test_failed`. Tool results are matched to tool uses by id within the file (keep a per-file map of the last 500 tool uses in the cursor value as JSON if needed, or re-derive from the record).
  - Dedupe key: `dedupeKey('claude', file, endOffset, index)`.
  - Cursor key = file path, value = `nextOffset`.
- [ ] **Step 5: Run** `npm run check` → PASS.
- [ ] **Step 6: Commit** `git commit -m "feat(claude): incremental jsonl reader and claude code collector"`

---

### Task 7: Codex CLI collector

**Files:**
- Create: `src/collectors/codex.ts` (extend `jsonl-reader.ts` with `readZstJsonl`)
- Test: `tests/collectors/codex.test.ts`, fixtures `tests/fixtures/codex/*.jsonl`, `*.jsonl.zst`

**Interfaces:**
- Produces:
  - `readZstJsonl(file: string, skipLines: number): Promise<{ records: unknown[]; totalLines: number; malformed: number }>` (uses `fzstd`)
  - `codexCollector: Collector`, `parseCodexRecord(rec: unknown, file: string, pos: number): WorkEvent[]`

- [ ] **Step 0: Check access.** Run `codex --version` and try one short session. If Codex cannot run a session with the developer's current login, stop and ask whether to defer this task: if deferred, ship with the codex collector disabled (`collectors.codex = false`), keep the `Collector` interface ready, and note it in README as "coming soon".
- [ ] **Step 1: Capture real fixtures** from `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` with the same scenario as Task 6; produce a `.zst` copy with `zstd`. Record the Codex version in `tests/fixtures/codex/README.md`.
- [ ] **Step 2: Write failing tests**

```ts
test('plain rollout → same kinds as claude scenario', ...);
test('project root from session metadata cwd', ...);
test('zst file read fully once, skipped when size+mtime unchanged', ...);
test('zst file above codex.maxCompressedMb is skipped with a warning', ...);
test('missing ~/.codex → isAvailable false, no throw', ...);
test('unknown record types ignored', ...);
```

- [ ] **Step 3: Run** → FAIL. **Step 4: Implement.** Plain files: byte cursor as in Task 6. `.zst`: cursor value = `JSON.stringify({ size, mtimeMs, lines })`; when size or mtime changes, decompress and skip the first `lines` records. Map records using the fixtures (session metadata → project; user/assistant messages; shell/function calls → `command`; their outputs with non-zero exit → `command_failed`; patch/apply events → `file_edit`). **Step 5: Run** `npm run check` → PASS.
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

Contract: each collector runs in its own try/catch under `withBudget` (default `budgetMs` 1200 split evenly; a timed-out collector reports `error` with `detail: 'timeout'` and its cursors are not committed). For each collector: insert events, then commit `pendingCursors`, both in one transaction (so a crash between them cannot skip data). After shell commit, truncate the processed prefix of `shell.log`. Prune events older than `retentionDays` at most once per hour (timestamp in `cursors` as `('ingest','last_prune')`).

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
  - `factsHash(f: BriefFacts): string` (sha1 of JSON excluding `lastActiveAt` and `sources`)

- [ ] **Step 1: Write failing tests** — build the §1.1 Rahul scenario as an event list helper `rahulEvents()` used here and in Task 16.

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
test('attempts capped at 5 and deduplicated', ...);
test.each([
  ['note next: wins', { notes: ['next: try OAuth app password'] }, 'try OAuth app password'],
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
- [ ] **Step 5: Commit** `git commit -m "feat(brief): sessions, open problems, next step, facts"`

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
test('NO_COLOR disables ANSI', ...);
test('agent context starts and ends with exact lines and is ≤ 4000 chars even with 200 files', ...);
test('json render is valid JSON with facts and polished', ...);
test('relativeAgo / parseSince', ...);
test('resume in a project with no data prints a friendly line and exits 0', async () => {
  expect((await runResume({ cwd: emptyDir, format: 'terminal', polish: false })).output).toContain('No activity recorded yet');
});
test('note appears in next resume output', ...);
```

Golden file `tests/render/golden/rahul.txt` must equal the brief in spec §1.1.

- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** `npm run check` → PASS.
- [ ] **Step 5: Commit** `git commit -m "feat(cli): renderers, resume and note commands"`

---

### Task 11: Standup command

**Files:**
- Create: `src/render/standup.ts`, `src/cli/commands/standup.ts`
- Test: `tests/render/standup.test.ts`, `tests/cli/standup.test.ts`

**Interfaces:**
- Produces:
  - `buildStandup(input: { factsByProject: BriefFacts[]; eventsSince: WorkEvent[] }): { yesterday: string[]; today: string[]; blockers: string[] }`
  - `renderStandup(s): string` (exact headings §1.8)
  - `runStandup(opts: { cwd: string; since?: string; all: boolean; copy: boolean }): Promise<{ output: string; exitCode: number }>`

Default `since` = start of previous local day when today is Mon–Fri and previous working day is Friday on Mondays. Yesterday = commit subjects + "Worked on <files> with <agent>" per project; Today = next steps; Blockers = open problems. Prefix items with project name when `--all`. `--copy` tries `pbcopy`, `wl-copy`, `xclip -selection clipboard` in order; prints `(copied)` or `(clipboard tool not found)`.

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
test('Monday since covers Friday', ...);
test('no activity → Blockers: none and a friendly Yesterday line', ...);
test('--all prefixes project names', ...);
```

- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** `npm run check` → PASS.
- [ ] **Step 5: Commit** `git commit -m "feat(cli): standup command"`

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
  - `spawnBackgroundSummarize(root: string): void` — `spawn(process.execPath, [cliPath, 'internal', 'summarize', '--project', root], { detached: true, stdio: 'ignore', env: { ...process.env, LEFTOFF_INTERNAL: '1' }, cwd: paths().tmp }).unref()`
  - `runInternalSummarize(root: string): Promise<void>` — `acquireLock('summarize:' + root, pid, 120_000)`; if false, return; ingest; `polishNow`; release.

Provider details (verify exact flags with `claude --help` / `codex --help` / Ollama docs while implementing; required behavior in parentheses):
- `claude-cli`: `claude -p` with the prompt on stdin, text output (single turn, no tools, no interactive prompts), cwd `paths().tmp`, env `LEFTOFF_INTERNAL=1`.
- `codex-cli`: `codex exec` non-interactive with the prompt (same requirements).
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
test('prompt contains facts JSON and the no-invention instruction, ≤ 8000 chars', ...);
```

- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** `npm run check` → PASS.
- [ ] **Step 5: Commit** `git commit -m "feat(polish): optional llm polish with background summarize"`

---

### Task 13: Claude Code plugin and hook commands

**Files:**
- Create: `plugin/.claude-plugin/plugin.json`, `plugin/hooks/hooks.json`, `.claude-plugin/marketplace.json`, `src/cli/commands/hook.ts`, `src/install/claude-plugin.ts`
- Test: `tests/cli/hook.test.ts`, `tests/install/claude-plugin.test.ts`

**Interfaces:**
- Consumes: `runResume` pieces (`ingest`, `buildFacts`, `renderAgentContext`), `spawnBackgroundSummarize`, `makeEvent`.
- Produces:
  - `runHook(name: 'claude-session-start' | 'claude-stop' | 'claude-session-end', stdin: string): Promise<{ stdout: string }>` — never throws.
  - `installClaudePlugin(): Promise<'installed' | 'already' | 'claude-not-found' | 'failed'>`, `claudePluginInstalled(): Promise<boolean>`

`hooks.json` registers: `SessionStart` with matcher `startup|clear|compact` → `leftoff hook claude-session-start` (timeout 5 s); `Stop` → `leftoff hook claude-stop` (timeout 2 s); `SessionEnd` → `leftoff hook claude-session-end` (timeout 2 s). Each command is wrapped so a missing binary is silent: `command -v leftoff >/dev/null 2>&1 && leftoff hook <name> || true`.

Behavior:
- Any hook with `LEFTOFF_INTERNAL=1` → empty stdout immediately.
- `claude-session-start`: parse stdin JSON (`session_id`, `transcript_path`, `cwd`, `source`); record `session_start` event with `data.transcriptPath`; within 2000 ms budget: ingest (budget 1000 ms), facts, `renderAgentContext`; print `{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"…"}}`. If the project has no prior events, or budget exceeded, print nothing.
- `claude-stop`: record `checkpoint` with transcript path. Nothing printed.
- `claude-session-end`: record `session_end`; `spawnBackgroundSummarize(project)` if polish is not `off`. Nothing printed.
- `installClaudePlugin`: if `claude` on PATH, run `claude plugin marketplace add <github-repo>` then `claude plugin install leftoff@<marketplace-name>` (verify current CLI syntax with `claude plugin --help`); on failure print the two commands for the user to run.

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
test('session-end spawns summarize only when polish enabled', ...);
test('hooks.json is valid and references the three hooks', () => { /* JSON.parse + shape asserts */ });
test('real CLI: `leftoff hook claude-stop` exits 0 with empty stdout on empty stdin', () => { /* execFileSync built dist */ });
```

- [ ] **Step 2: Run** → FAIL. **Step 3: Implement**; also validate with `claude plugin validate plugin` locally if Claude Code is installed. **Step 4: Run** `npm run check` → PASS.
- [ ] **Step 5: Commit** `git commit -m "feat(claude): plugin hooks inject brief and record sessions"`

---

### Task 14: Auto brief on terminal open

**Files:**
- Create: `src/render/auto.ts`, `src/cli/commands/brief-auto.ts`; modify `shell/leftoff.zsh`, `shell/leftoff.bash`, `shell/leftoff.fish` (`__leftoff_auto`)
- Test: `tests/cli/brief-auto.test.ts`, `tests/render/auto.test.ts`

**Interfaces:**
- Produces:
  - `isBriefDue(root: string, repo: Repo, config: Config, now: Date): boolean` — true iff `autoBrief.enabled`, `LEFTOFF_QUIET` unset, `lastActivity(root)` exists and is ≥ `gapHours` before `now`, and `briefShownFor(root)` < that activity.
  - `renderAutoBrief(f: BriefFacts): string` (≤ 8 lines, exact first/last lines §1.8)
  - `runBriefAuto(cwd: string): Promise<string>` — 300 ms total budget; **no ingest** except the git working state; uses stored events only; marks shown.

Shell wiring: `__leftoff_auto` runs `leftoff brief --auto` on the first prompt of an interactive shell and on directory change into a different project (compare `git rev-parse --show-toplevel` output cached in a shell variable; fall back to `$PWD`). Output goes to the terminal (stderr is discarded).

- [ ] **Step 1: Write failing tests**

```ts
test('due after 4h gap, not due twice', ...);
test('not due when LEFTOFF_QUIET=1 or autoBrief.enabled=false', ...);
test('auto brief ≤ 8 lines with exact first and last lines', ...);
test('runBriefAuto returns "" when over budget', ...);
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
- Consumes: `installShellHook`, `removeShellHook`, `installClaudePlugin`, `claudePluginInstalled`, `pickProviders`, `Repo`, `readRecentErrors`.
- Produces:
  - `runSetup(io: Prompter, env: SetupEnv): Promise<SetupResult>` — `Prompter` = `{ confirm(q: string, def: boolean): Promise<boolean>; choose<T extends string>(q: string, options: T[], def: T): Promise<T>; input(q: string, def?: string): Promise<string> }` (implemented with `node:readline/promises`; tests inject a scripted prompter). `SetupEnv` = `{ home: string; shell: string; hasClaude: boolean; hasCodex: boolean; hasOllama: boolean }`.
  - `runDoctor(): Promise<{ checks: { name: string; ok: boolean; hint?: string }[]; exitCode: 0 | 1 }>`
  - `runStatus(): Promise<string>`, `runForget(opts: { project?: string; all: boolean; yes: boolean }, io: Prompter): Promise<string>`, `runConfig(args: string[]): Promise<{ output: string; exitCode: number }>`, `runUninstall(io: Prompter): Promise<string>`

Setup steps, in order: (1) create home; (2) detect shells from `$SHELL` + existing rc files, offer to install hook into `~/.zshrc` / `~/.bashrc` / `~/.config/fish/config.fish`; (3) if Claude Code found, offer plugin install; (4) note Codex logs found or not; (5) polish: offer `off` (default), `claude-cli`, `codex-cli`, `ollama` (ask model), `anthropic`/`openai` (ask model, require env key), explaining in one line which ones send data off the machine; (6) print a summary and "Open a new terminal to start". Re-running setup shows current choices as defaults.

Doctor checks (each with a fix hint): Node ≥ 22; platform supported; home dir permissions; DB opens and `user_version` current; config valid; each rc hook block present; shell log received a line in the last 7 days (if hook installed); Claude plugin installed and a `session_start` event in the last 7 days (if Claude found); Codex sessions readable; malformed-line counts from last ingest; polish provider available (if not `off`); last 5 errors from the log.

- [ ] **Step 1: Write failing tests**

```ts
test('setup with scripted answers installs zsh hook and writes config', ...);
test('setup is idempotent', ...);
test('doctor flags missing shell hook with hint "Run leftoff setup"', ...);
test('doctor exit code 1 when any check fails', ...);
test('forget --project removes only that project', ...);
test('config set/get/list round-trip and rejects unknown keys', ...);
test('uninstall removes rc blocks and keeps data unless confirmed', ...);
```

- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** `npm run check` → PASS.
- [ ] **Step 5: Commit** `git commit -m "feat(cli): setup, doctor, status, forget, config, uninstall"`

---

### Task 16: End-to-end and performance tests

**Files:**
- Create: `tests/e2e/rahul.e2e.test.ts`, `tests/e2e/perf.e2e.test.ts`, `tests/e2e/helpers.ts`
- Modify: `.github/workflows/ci.yml` (add `npm run build` before e2e; run e2e on both OSes)

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

- [ ] **Step 2: Run** `npm run build && npx vitest run tests/e2e` → fix anything failing in the owning module (with a regression test there).
- [ ] **Step 3: Commit** `git commit -m "test: end-to-end scenario and performance budgets"`

---

### Task 17: Packaging, docs and release

**Files:**
- Create: `README.md`, `CONTRIBUTING.md`, `LICENSE` (MIT), `CHANGELOG.md`, `docs/adding-a-collector.md`, `.github/workflows/release.yml`, `demo/demo.tape`
- Modify: `package.json` (final name, `files`, `repository`, `keywords`), `plugin/.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json` (repo URLs)

- [ ] **Step 1: Confirm package identity.** `package.json` `name` is `@leftoff-dev/cli`, `bin` is `{"leftoff": "dist/cli.js"}`, `publishConfig.access` is `public`, `repository` points at `github.com/GITHUBTANMAY2003/leftoff`. Bump from the placeholder `0.0.1` to `1.0.0`. Plugin and marketplace manifests use the same repo URL.
- [ ] **Step 2: README** — the one-line pitch, a demo GIF (record with `vhs demo/demo.tape` showing: close terminal → reopen → auto brief → `leftoff standup`), install (`npm i -g @leftoff-dev/cli && leftoff setup`), what is recorded and where, privacy section (local only, redaction, `forget`, polish providers that leave the machine), commands table from spec §1.10, troubleshooting = `leftoff doctor`, uninstall.
- [ ] **Step 3: CONTRIBUTING + docs/adding-a-collector.md** — the `Collector` interface, fixture capture procedure from Task 6, test checklist (malformed lines, partial lines, dedupe, budget).
- [ ] **Step 4: release.yml** — on tag `v*`: `npm ci && npm run check && npm run build && npm publish --provenance --access public` (needs `NPM_TOKEN` secret), create a GitHub Release with the CHANGELOG section.
- [ ] **Step 5: Fresh-machine check** — in a clean Docker `node:22` container and on a macOS machine: install from the packed tarball (`npm pack`), run `leftoff setup`, use Claude Code for 5 minutes, open a new terminal after setting `autoBrief.gapHours 0`, confirm the brief appears and `leftoff doctor` is all green. Record results in the PR.
- [ ] **Step 6: Commit** `git commit -m "docs: readme, contributing, release workflow"` and tag `v1.0.0`.

---

## Self-review notes

- Spec coverage: §1.2 D1–D10 and §1.3 P1–P12 each map to tasks (D3/D4 → 4–7; D6 → 12; D7 → 10, 13, 14; D9 → 2; D10 → 8, 13, 15; P7 → 14; P10 → 3, 4, 12, 15; P11 → 10; P12 → 13, 17).
- Interfaces: `Collector.collect` returns `{ events, pendingCursors, warnings }` everywhere (Tasks 4–8). `BriefFacts`/`OpenProblem` defined once in §1.7 and used by Tasks 9–14.
- Review Focus items each have a named test in their owning task.
