# Task 00: Plan review

Review of `docs/leftoff-implementation-plan.md` (commit `be33987`) before any code is written.

I checked the plan against the real tools on this machine on 2026-10-24:

| Tool | Version found | How checked |
|---|---|---|
| Node / npm | v26.12.0 / 11.20.0 | `node --version` |
| git | 2.50.1 | `git --version` |
| Claude Code | 2.1.310 | `claude --version`, `claude --help`, `claude plugin … --help` |
| Codex | codex-cli 0.163.0 | `codex --version`, `codex exec --help` |
| zstd | 1.5.7 | `zstd --version` |
| /bin/bash | 3.2.57 | `/bin/bash --version` |
| zsh | /bin/zsh present | `which` |
| fish | **not installed** | `which fish` |
| ollama | /opt/homebrew/bin/ollama present | `which` |
| vhs | **not installed** | `which vhs` |
| npm registry | `@leftoff-dev/cli` 0.0.1, `latest` tag | `npm view` |

I also read the Claude Code hooks reference (https://code.claude.com/docs/en/hooks). In a scratch folder outside the repo, I test-installed `better-sqlite3@13` and loaded it under Node 26.

**Nothing in `~/.claude`, `~/.codex` or `~/.leftoff` was read or changed.**

Items are labelled **[BLOCKER]** (must be decided before the task it affects), **[DECIDE]** (needs your answer), or **[RISK]** (no decision needed now; something to watch).

---

## 1. Unclear, contradictory or risky points in the plan

### 1.1 Tooling and dependencies

**A1 [BLOCKER for Task 1] TypeScript 7 breaks the lint setup.**
`npm view typescript` shows `latest` = **7.0.2**. `typescript-eslint` 8.72.0, the latest, declares the peer dependency `typescript: ">=4.8.4 <6.1.0"`. A plain `npm i -D typescript` would install 7.x, and `eslint .` (part of `npm run check`) would then be unsupported.
→ Proposal: pin `typescript@~6.0.3`, the newest 6.0.x, in `devDependencies`.

**A2 [DECIDE] The `engines` field is too loose.**
The plan says `"node": ">=22"`, but the current versions of the dependencies require more:
- `commander@15` (a runtime dependency): `>=22.12.0`
- `vitest@5`: `^22.12.0 || ^24 || >=26`
- `tsup@9`: `^22.18.0 || ^24.11.0 || >=26`

→ Proposal: `"engines": {"node": ">=22.12"}`, and add Node **26** to the CI matrix next to 22 and 24, since you develop on 26.

**A3 [OK] `better-sqlite3` on Node 26: verified.**
`better-sqlite3@13.0.3` ships prebuilt N-API binaries (no `install` script, `gypfile: false`). It installed and ran `select sqlite_version()` on Node 26.12 without compiling. No action needed.

**A4 [DECIDE, optional] `fzstd` could be dropped.**
Node's own `zlib` has had zstd (`zlib.zstdDecompressSync` and streams) since v22.15 / v23.8; I confirmed it exists on Node 26. `fzstd` has not been updated since March 2024. Using `node:zlib` would remove one of the three runtime dependencies, at the cost of raising `engines` to `>=22.15`.
This only matters if Codex actually writes `.jsonl.zst` files (see C5). Default if you don't answer: keep `fzstd` as the plan says.

**A5 [BLOCKER for Task 2] Child-process tests can't load the TypeScript source.**
Task 2's "two processes writing concurrently" test spawns child `node` processes, which need to load `src/store/db.ts`. There's no `tsx`, and Node's built-in type stripping doesn't map the usual `./x.js` import specifiers to `.ts` files.
→ Proposal for `tsconfig.json`:
- write imports with `.ts` extensions (`allowImportingTsExtensions` + `rewriteRelativeImportExtensions`);
- set `erasableSyntaxOnly: true`, which forbids `enum` and parameter properties.

Child processes in tests can then run the source directly with Node's type stripping (Node ≥22.18). `tsup` still bundles the published build. The alternative is to have such tests import the built `dist/`, which drags `npm run build` into unit tests (see A6).

**A6 [DECIDE] `npm run check` vs tests that need `dist/`.**
- CI runs `npm ci && npm run check && npm run build`, so `check` runs before anything is built.
- Task 13 includes "real CLI: `leftoff hook claude-stop` … `execFileSync` built dist", which would fail in CI and on a fresh checkout.
- Task 16 puts e2e tests under `tests/`, which `vitest run` (inside `check`) would also pick up before the build exists.

→ Proposal:
- `vitest.config.ts` excludes `tests/e2e/**`;
- add a script `test:e2e` = `npm run build && vitest run tests/e2e`;
- move Task 13's real-CLI test into `tests/e2e/`;
- CI then runs `check`, `build`, `test:e2e`.

This adds one npm script, which the plan does not list.

**A7 [RISK] Prettier is configured but never checked.**
`.prettierrc` is in the plan, but `check` doesn't run `prettier --check`. Unless you want it in `check`, I'll leave it that way.

### 1.2 Contradictions inside the plan

**B1 [BLOCKER for Task 13] P8 and Task 13 disagree about SessionEnd.**
- P8: SessionEnd "records the end **and starts** a short detached background summarize" (always).
- Task 13: spawn summarize "**if polish is not `off`**". `off` is the default.

With the Task 13 rule and default config, nothing ingests the Claude transcript after a session ends. `brief --auto` (Task 14) deliberately does no ingest. So the next morning's auto brief would be built from events stored *before* the last Claude session and would miss its errors and open problems, which is the core use case.
→ Proposal: SessionEnd always spawns the background `internal summarize`. That step always ingests, and only calls a polish provider when polish is enabled.

**B2 [DECIDE] Notes have no heading.**
P11 says notes "always appear in the brief", but §1.8 lists the exact terminal headings and none of them is for notes. The §1.1 golden file has no notes either.
→ Proposal: a `Notes` section after `Open problems` and before `Next step`, omitted when there are no notes.

**B3 [DECIDE] The §1.1 golden brief can't be produced by the §1.7 rules.**
Task 10 says the golden file "must equal the brief in spec §1.1". The differences:
- `Done` shows `Added reset-token migration (commit a1b2c3d)`. §1.7 says `done` = commit subjects, with no hash. The Task 11 standup also expects the subject without a hash.
- `Done` shows `Built POST /auth/forgot-password endpoint`. That's only possible if it is a commit subject. But Task 16's e2e repo has a single commit ("Added reset-token migration").
- §1.7 adds `Edited N files: …` after the commit subjects; the golden file has no such line.
- Footer: §1.1 ends with ``Run `leftoff resume` for full details · `leftoff standup` for your standup``. §1.8 doesn't list a footer for the full brief, and printing "run `leftoff resume`" inside `leftoff resume`'s own output is odd.
- `Sources:` order: §1.1 shows `claude, git, shell, codex`, but Task 8's collector order is `claude, codex, shell, git`.

→ Proposal:
1. The `rahulEvents()` helper contains two commits, "Built POST /auth/forgot-password endpoint" and "Added reset-token migration".
2. The rendered `Done` line uses the subject only, with no `(commit …)`.
3. The full brief has no footer line.
4. The Sources line uses the fixed order of §1.1.
5. I update §1.1 in the plan to match the golden file, so the spec and the test agree.

Please confirm or correct each point.

**B4 [DECIDE] The Task 11 standup rule contradicts its own test.**
The rule says Yesterday = commit subjects **+ "Worked on <files> with <agent>" per project**. In the Rahul scenario Claude edited `email_service.py`, so the rule would add `- Worked on email_service.py with claude`. The expected output in the test doesn't have that line.
Which one wins?
- (a) Drop the "Worked on" line whenever the project has commits in the window.
- (b) Keep the rule and add the line to the expected output.

**B5 [DECIDE] Who trims `shell.log`, and when.**
- Task 4: "After a successful ingest commit, the processed prefix of the file is removed" (in the collector).
- Task 8: ingest does it "after shell commit".

The `Collector` interface (`isAvailable`, `collect`) has no step that runs after the commit, so ingest would have to special-case the shell collector by name.
→ Proposal: add an optional `afterCommit?(ctx): Promise<void>` to `Collector`. Ingest calls it after the transaction commits, and the shell collector trims there. This is an interface change, so I need your OK.

**B6 [RISK + proposal] Trimming `shell.log` loses commands.**
The plan's method is: read the remaining bytes, write them to a temp file, rename it over `shell.log`. Any line a shell appends between the read and the rename goes into the old inode and is lost. With several terminals open, this will happen.
→ Proposal (Task 4/8): rotate by rename instead:
1. Ingest atomically renames `shell.log` to `shell.log.<pid>.ingesting`. Shells reopen the log path on every command (`>>`), so their next line goes into a fresh `shell.log`.
2. Ingest reads the renamed file.
3. Ingest deletes the renamed file after commit. If a line was cut short, ingest prepends it to the new file first.

The byte cursor then only matters within a single run. The behaviour you see doesn't change: processed bytes are removed and no line is lost.

**B7 [RISK + decide] Bash 3.2 has no millisecond clock and no start-of-command hook.**
The log format needs `ts_epoch_ms` and `duration_ms`. Each shell can provide:
- **zsh:** `$EPOCHREALTIME` (via `zsh/datetime`). Fine.
- **fish:** `$CMD_DURATION`. Fine.
- **bash 3.2:** no `$EPOCHREALTIME` (that's bash 5). macOS `date` has no `%N`. The plan also uses `history 1` in `PROMPT_COMMAND`, which runs *after* the command, so there is no start time at all. Forking `perl` or `python` per command would break the "< 5 ms per command" budget.

→ Proposal: bash ≥ 5 uses `$EPOCHREALTIME`. Bash < 5 writes `ts` = `$(date +%s)` × 1000 (one fork, about 1–2 ms) and `duration_ms` = `-1`, meaning unknown, which the collector stores as `durationMs: null`.

**B8 [DECIDE] Where the rc block points to.**
Task 4: the rc block sources "the installed script path". If that path is inside the npm package (e.g. `…/lib/node_modules/@leftoff-dev/cli/shell/leftoff.zsh`), it breaks when you switch Node versions (nvm/fnm) or reinstall, and every new shell then prints `no such file` errors. That would violate D10.
→ Proposal: `setup` copies the scripts to `~/.leftoff/shell/leftoff.{zsh,bash,fish}` and the rc block sources that path, guarded with `[ -r … ] && source …`. `doctor` warns when the copied scripts are older than the installed CLI version, and re-running `setup` refreshes them.

**B9 [DECIDE] The `Config` shape is spread across the document.**
Here is the full shape I'd implement in Task 1, collected from §1.3, §1.9, the Global Constraints and Tasks 4/8/14:

```ts
{
  sessionGapMinutes: 45,
  retentionDays: 30,
  autoBrief: { enabled: true, gapHours: 4 },
  ingest: { maxBytesPerFilePerRun: 52428800 },
  codex: { maxCompressedMb: 200 },
  collectors: { claude: true, codex: true, shell: true, git: true },
  ignore: { projects: [] as string[], commands: [] as string[] },   // globs
  polish: { provider: 'off', enabled: [] as string[], ollamaModel: null as string | null, apiModel: null as string | null },
  looseEnds: { staleDays: 3, maxProjects: 20 },
}
```

The config file would be `~/.leftoff/config.json`, written with mode 600.

Open sub-question: how should `leftoff config set` parse list values (`ignore.projects`, `polish.enabled`)?
→ Proposal: comma-separated (`leftoff config set ignore.projects "~/secret/*,/tmp/*"`); `""` means an empty list.

**B10 [DECIDE] Task 8 needs `IngestReport` to carry malformed-line counts.**
Doctor (Task 15) shows "malformed-line counts from last ingest", but `IngestReport` has no field for them and nothing stores them.
→ Proposal:
- collectors report malformed counts in `warnings`, as strings like `malformed:3`;
- ingest stores the last report in `cursors` as `('ingest', 'last_report')`, as JSON;
- doctor reads it from there.

No new table or interface member.

**B11 [DECIDE] Commit hashes in PROGRESS.md and reports.**
You asked for the commit hash and `git show --stat` in each report and in PROGRESS.md, both inside that same commit. A commit can't contain its own hash.
→ Proposal: each task's commit, using the plan's exact message, contains the report and PROGRESS.md with "Commit: see next task". The *next* task's commit fills in the previous hash and `git show --stat` output. The final task (18) gets one small `docs: record task 18 commit` commit. I'll also give you the hash in chat right after each commit.

This report (task 00) follows that proposal: its §10 is filled in by Task 1's commit.

### 1.3 Mismatches with the real tools

**C1 [OK + note] Claude Code hook stdin fields: verified against the docs.**
- Common fields: `session_id`, `transcript_path`, `cwd`, `hook_event_name` (plus `permission_mode`, `effort`, `prompt_id` and others we don't need).
- SessionStart adds `source` ∈ `startup | resume | clear | compact | fork`.
- SessionEnd's matcher values are `clear | resume | logout | prompt_input_exit | other`.
- Output shape `{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"…"}}` is confirmed.
- Hook output strings are capped at 10,000 characters by Claude Code. Our 4,000 limit is well inside that.
- Hook `timeout` is in seconds. Shell-form commands run via `sh -c`, so the `command -v leftoff … || true` wrapper works.

Task 6 will still record the exact stdin fields seen in a real session, as the plan says.

**C2 [DECIDE] The SessionStart matcher leaves out `resume` and `fork`.**
P8 uses `startup|clear|compact`. Claude Code also has `resume` and `fork`. Leaving them out seems right, since those sessions already carry the earlier transcript. Please confirm that's intended.

**C3 [RISK] SessionEnd has a shared 1.5 s budget.**
The docs say SessionEnd hooks share a 1.5 s budget, raised to the largest per-hook `timeout` (≤ 60 s). The plan's `timeout: 2` raises it to 2 s, and our internal budget is 500 ms, so we're inside it. Whether a `detached` + `unref()` child survives Claude Code exiting is not documented. I'll check that in Task 13 with your OK, in a real session.

**C4 [RISK] Hooks may not find `leftoff` on PATH.**
Hooks run with Claude Code's environment. When Claude Code is started from the desktop app rather than a login shell, an nvm/fnm global `bin` may not be on `PATH`. The `command -v leftoff … || true` wrapper then silently skips every hook. Nothing crashes, but nothing gets recorded either.
`doctor`'s check ("a `session_start` event in the last 7 days") will catch it. Task 17 is where we'll find out on your machine. A fix could be for `setup` to write the absolute `leftoff` path into the hook command, but that is not in the plan, so I'm only flagging it.

**C5 [BLOCKER for Task 7] The Codex log format is unverified.**
I haven't looked inside `~/.codex`. Whether Codex 0.163 writes `rollout-*.jsonl.zst` at all, and what the record types are, has to come from real files in Task 7. The `.zst` part of the plan (and A4) may turn out to be unnecessary.

**C6 [DECIDE] Honor `CLAUDE_CONFIG_DIR` and `CODEX_HOME`.**
Claude Code relocates `~/.claude` when `CLAUDE_CONFIG_DIR` is set. Codex uses `CODEX_HOME`, which `codex exec --help` mentions. The plan hard-codes `~/.claude/projects` and `~/.codex/sessions`.
→ Proposal: the collectors use those environment variables when set, falling back to `$HOME/.claude` and `$HOME/.codex`. It's a few lines, and tests point them at temp folders.

**C7 [DECIDE, for Task 12] Flags that make polish safer, now that I've seen the real CLIs.**
- `claude -p`: add `--no-session-persistence` (no transcript is written at all, which removes most of Review Focus 1) and `--tools ""` (no tools). **Not** `--bare`: `--help` says it skips hooks but also "keychain reads", and on macOS that would likely break your subscription login.
- `codex exec`: needs `--skip-git-repo-check`, because the polish cwd `~/.leftoff/tmp` is not a git repo and `codex exec` refuses to run outside one without that flag. Also add `--ephemeral` (no session files) and `-s read-only`.

`LEFTOFF_INTERNAL=1` and cwd `~/.leftoff/tmp` stay as a second line of defence.

**C8 [DECIDE, for Task 13] Installing the plugin.**
The real syntax is `claude plugin marketplace add <owner/repo | path>` then `claude plugin install leftoff@<marketplace>`. There's also a one-step form: `claude plugin install leftoff --marketplace <source>`.
- Before the repo is public and pushed, the GitHub form can't work. For dogfooding (Task 17), the marketplace must be added from the local path `/Users/apple/leftoff`.
- → Proposal: marketplace name `leftoff`, so the plugin id is `leftoff@leftoff`.

### 1.4 Product and design risks

**D1 [DECIDE] "Agent said done, but N uncommitted files" may fire on most sessions.**
Many developers don't let the agent commit; they review the diff first. Under §1.7, *any* "done" message followed by uncommitted files and no commit gets flagged. That would make the headline feature noisy, which is exactly what Review Focus 6 warns about.
Options:
- (a) Keep the rule as written and judge it during dogfooding (Task 17).
- (b) Count only uncommitted files the **agent edited after its claim**.
- (c) Raise uncommitted files only when the claim explicitly says "committed" or "ready to merge".

My recommendation is (a): keep the plan, measure during dogfooding. I'm noting it now so it isn't a surprise.

**D2 [RISK] The attempt text in the §1.1 example is idealized.**
`tried: changed port to 587 · disabled TLS` assumes `file_edit`/`command` summaries read like intentions. From real transcripts they will read like `Edited email_service.py` or `python scripts/send_test.py`. The unit test helper can use any summaries, but real briefs will look more mechanical than §1.1 unless polish is on.

**D3 [RISK] Raw `shell.log` grows when nothing ingests.**
Ingest only runs on `resume`, `loops`, Claude session start and (after B1) session end. A terminal-only user who relies on the auto brief never ingests. `shell.log` then keeps growing with unredacted commands, mode 600 but on disk. The auto brief also won't show recent shell failures.
A possible fix, **not in the plan** and not proposed for now: `brief --auto` spawns a detached background ingest. I'm flagging it for Task 14 or 17.

**D4 [RISK] Claude collector's first run could scan everything.**
"mtime newer than newest stored claude cursor minus 1 day": on the first run there are no cursors, so every transcript you have ever written would qualify.
→ Proposal: with no cursors, consider only files modified within the last `retentionDays`. Older events would be pruned anyway.

**D5 [RISK, decide] The perf test writes 600 MB.**
Task 6's reader perf test creates a 600 MB file on every run that doesn't set `CI_FAST`. CI doesn't set it, so this would run on four or six CI jobs. The behaviour under test (stop after 50 MB, resume next call) is identical with a ~60 MB file.
→ Proposal: 60 MB.

**D6 [RISK] Redaction patterns need word boundaries.**
`sk-[A-Za-z0-9_-]{20,}` without a leading `\b` would redact `risk-assessment-for-the-quarter`. The `auth` assignment rule must not catch the `Authorization: Bearer` header (the Bearer rule handles that). I'll add regression tests for both in Task 3. This is how the patterns get implemented, not a change in behaviour.

**D7 [RISK] Shells missing in tests and CI.**
- fish isn't installed on your Mac.
- I'm not sure `ubuntu-latest` runners have zsh or fish preinstalled, or that `macos-latest` has fish.

→ Proposal: shell tests `skipIf` the shell binary is missing, and CI installs them explicitly (`sudo apt-get install -y zsh fish` / `brew install fish`). That's a CI step not listed in the plan.

**D8 [RISK] Plan header vs your workflow.**
The plan's header says to use subagent-driven development. Your instructions say I build one task at a time, myself, with a report and a stop after each. I'll follow your instructions: inline, no subagents.

**D9 [RISK] The plan's file tree is out of date.**
It doesn't list `src/brief/loose-ends.ts`, `src/render/loose-ends.ts` or `src/cli/commands/loops.ts` (added in Task 11 after the repositioning commit), nor `docs/reports/` or `docs/PROGRESS.md`. Task 11's file list is authoritative; I'll treat the tree as informational.

---

## 2. Questions to answer before Task 1

These block Task 1 or set conventions for every task. Everything else in §1 can be answered when its task comes up.

1. **TypeScript version (A1):** OK to pin `typescript@~6.0.3`?
2. **Engines and CI matrix (A2):** `"node": ">=22.12"` and CI on Node 22, 24, **26**?
3. **Imports and type stripping (A5):** OK to use `.ts` import extensions with `allowImportingTsExtensions` + `rewriteRelativeImportExtensions` + `erasableSyntaxOnly`?
4. **e2e split (A6):** OK to exclude `tests/e2e` from `npm run check`, add a `test:e2e` script, and run it in CI after `build`?
5. **Config shape (B9):** Is the full `Config` above right, including `autoBrief.enabled: true`, file `~/.leftoff/config.json`, and comma-separated list values for `config set`?
6. **Commit hashes (B11):** OK to backfill each task's hash in the next task's commit?
7. **Branch:** Should I commit directly to `main`, or to a feature branch that you merge?
8. **`fzstd` (A4):** Keep it (default), or use `node:zlib` zstd? Can wait until Task 7.

Decisions needed later (I'll stop and ask again at the task, but you can answer now):
- Task 4: B5 (`afterCommit`), B6 (rotate by rename), B7 (bash 3.2 timing), B8 (copy scripts to `~/.leftoff/shell`), D7 (fish).
- Task 6: C6, D4, D5.
- Task 8: B10.
- Task 10: B2, B3.
- Task 11: B4.
- Task 12: C7.
- Task 13: B1, C2, C8.
- Task 17: D1.

---

## 3. Points where I will need you

| Task | What I'll need from you | Why |
|---|---|---|
| Every task | Review the report, type `continue`; you push | Your workflow rule; I never push |
| 1 | Nothing outside the repo. `npm install` writes only `node_modules/` and `package-lock.json` in the repo | — |
| 4 | Decide whether to `brew install fish` on your Mac, or skip fish tests locally and rely on CI | Installing outside the repo needs your OK |
| 6 | Run a scripted Claude Code session in a scratch repo; I'll give the exact prompts (a prompt, an Edit, a successful Bash, `ls /nope`, a failing test, an abandoned retry). Approve me copying **that one** transcript file from `~/.claude/projects/…`. Review the fixture for personal info before commit | Real format; reading `~/.claude` needs your OK; privacy |
| 7 | Same for Codex. Approve listing and copying the file from `~/.codex/sessions/…`. If Codex can't run a session with your login, decide whether to defer Codex | Same; plan Step 0 |
| 12 | Approve each real `claude -p`, `codex exec` or Ollama call (Ollama is installed; you'd also pick a model). Unit tests use injected fakes only | Uses your subscription and local models |
| 13 | Approve installing the plugin into your real Claude Code from the local path. Then run one real session so we can confirm the brief is injected, `LEFTOFF_INTERNAL=1` stops recursion, and the SessionEnd background child survives exit (C3) | Changes `~/.claude` |
| 14 | Optional: try the auto brief in a real terminal. This needs the rc block in `~/.zshrc`, i.e. a real `setup` run | Changes `~/.zshrc` |
| 15 | Approve any real `leftoff setup` / `leftoff uninstall` run. Tests use a temp `HOME` only | Touches `~/.zshrc`, `~/.bashrc`, `~/.claude`, `~/.leftoff` |
| 16 | Nothing (temp `HOME`). Perf tests run locally and may take a minute | — |
| 17 | You run (or approve me running) `npm link`, then `leftoff setup` on your machine. You do 7+ days of daily use and write the dogfood log; I fix each reported bug with a regression test. You bump to and publish `1.0.0-beta.1` with `npm publish --tag beta`. You confirm every exit criterion before Task 18 | Global install, real rc files, your npm login |
| 18 | `brew install vhs` (or skip the GIF); `npm publish`; creating and pushing tag `v1.0.0`; GitHub settings; npm trusted publishing on npmjs.com; the fresh-machine test (I'll give you a checklist) | Accounts, 2FA, Touch ID, outside-repo installs |

---

## 10. Commit

Commit `76e3c17`, message `docs: add plan review and progress tracker`.

```
$ git show --stat --format='%h %s' 76e3c17
76e3c17 docs: add plan review and progress tracker

 docs/PROGRESS.md                    |  32 ++++
 docs/reports/task-00-plan-review.md | 306 ++++++++++++++++++++++++++++++++++++
 2 files changed, 338 insertions(+)
```

The owner answered this review on 2026-10-24. The decisions were applied to the plan in commit `11c35e4` ("docs: apply plan review decisions").
