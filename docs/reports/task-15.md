# Task 15: setup, doctor, status, forget, config, uninstall

This commit has three parts:

- **A.** Your answers to Task 14 §9: more probes, cleaned and shortened command display, a "(+N more problems)" wording, and the Task 16 plan note for a fast `cd`.
- **B.** Task 15 itself: the six commands, a prompter, and four small helpers they need.
- **C.** Test-suite stability: 4 workers, a 20 s unit timeout (from Task 14), and a 5 s shim check.

I did not run `setup` or `uninstall` on your real machine, as you asked. `doctor` and `status` only read; I ran both on your real data (§6.2). All command tests use a temp `HOME`, a temp `LEFTOFF_HOME`, and a `PATH` with no real `claude`, `codex` or `ollama`.

## 1. Goal

Make leftoff installable and diagnosable without editing files by hand: `leftoff setup` does everything Tasks 4, 12 and 13 prepared, `doctor` says what is wrong and how to fix it, `status` shows what is stored, `forget` deletes it, `config` changes settings, and `uninstall` takes the hooks out.

## 2. Files

**Created**
- `src/cli/prompter.ts`: the `Prompter` interface, and the terminal implementation.
- `src/cli/commands/{setup,doctor,status,forget,config,uninstall}.ts`
- Tests: `tests/cli/{setup,doctor,status,forget,config,uninstall}.test.ts`, `tests/render/text.test.ts`.
- Test helpers: `tests/helpers/home.ts` (temp HOME), `tests/helpers/prompter.ts` (scripted answers).

**Modified**
- `src/cli/index.ts`: `setup`, `doctor`, `status`, `forget`, `config`, `uninstall`.
- Part A:
  - `src/collectors/probes.ts`: the new probes;
  - `src/model/event.ts`: `displayCommand`;
  - `src/render/text.ts`: `clipMiddle`, `plural`;
  - `src/render/terminal.ts`, `loose-ends.ts`, `auto.ts`: `fitProblemLine`, "more problems";
  - `src/cli/commands/brief-auto.ts` and `shell/leftoff.{zsh,bash,fish}`: quiet mode still ingests;
  - `src/brief/facts.ts`: `OpenProblem.command` is the display form.
- Helpers for B:
  - `src/core/config.ts`: `CONFIG_KEYS`, `configProblems`;
  - `src/store/repo.ts`: `lastEventTs`, `countEvents`;
  - `src/install/shell-rc.ts`: `rcPathFor`, `hasShellHook`;
  - `src/install/shim.ts`: the shim check timeout.
- `vitest.config.ts`: 4 workers.
- Tests for A and the helpers, in the matching existing files.
- Docs: plan §1.7 (probes), §1.8 (problem lines), Task 15 (as built), Task 16 (Step 2a); `docs/PROGRESS.md`; the Task 14 report §10.

## 3. Interfaces produced

- `Prompter { confirm, choose, input, say }`. The plan listed the first three; `say` prints an explanation or a result as it happens.
- `runSetup(io, env): Promise<SetupResult>`. `SetupResult` has `shellHooks`, `plugin`, `polish` and `progress`. `SetupEnv` has the plan's five fields plus optional seams `cliPath`, `shellDir`, `pluginSource`, `ollamaList`, `ingest`. `detectSetupEnv()` builds the real one.
- `runDoctor(deps?): Promise<DoctorResult>` and `renderDoctor`. A check is `{ name, ok, detail?, hint?, warn? }`; the result also has `recentErrors`.
- `runStatus(deps?): Promise<string>`, `runForget(opts, io): Promise<string>`, `runConfig(args): Promise<{ output, exitCode }>`, `runUninstall(io, opts?): Promise<string>`.
- `displayCommand(cmd)`, `clipMiddle(text, max)`, `fitProblemLine(prefix, text, tail)`.
- `CONFIG_KEYS`, `configProblems()`, `Repo.lastEventTs({ source?, kind? })`, `Repo.countEvents(root?)`, `rcPathFor(shell, home)`, `hasShellHook(rc)`.

## 4. How it works

### Part A

**Probes** (plan §1.7). New read-only look-around commands, probe failures only with exit 1 or 2:
- `sed -n` (not `sed -i`), `lsof`, `ps`, `pwd`, `echo`, `printenv`, `date`, `uname`, `whoami`;
- `env` alone (with arguments it runs a command);
- any `<tool> --version`, `-V` or `--help` in the first two arguments. A missing tool exits 127, which stays a real failure.

Chains of these are scratch through Task 14's chain rule.

**Command display** (point 6). `displayCommand` applies the same cleanup as the comparison: redirects and trimming pipes (`normalizeCommand`), trailing filters of a single pipeline, then leading `cd`/`source`/`export`/`set`/`.` steps. A command that is nothing but setup is left as it is, and a chain of several real steps stays whole.

`OpenProblem.command` now holds that form. Every renderer shows it through `problemText`, so the brief, the auto brief, loops, the Markdown brief, the agent context and the standup all change together.

**Fitting a problem line.** A problem line is `` `command` — error ``.
- If it is too long (terminal brief, loose ends, auto brief), the command is shortened from the middle (`clipMiddle`): its first two words, ` … `, and its end. The tail never starts inside a word when a word boundary is available.
- The error keeps at least 40 characters, and the command at least 20.
- A trailing `(still failing)`, `(3 attempts)` or `(+5 more problems)` is reserved first, so it always survives.
- Text that isn't in that form is cut at the end as before.

**"(+N more problems)"** in the auto brief; `(+1 more problem)` for one.

**Quiet mode still ingests** (answer 1). Task 14 returned early on `LEFTOFF_QUIET`, and the shell scripts didn't even call `brief --auto` while it was set. Now:
- the scripts call it whenever `LEFTOFF_INTERNAL` isn't `1`;
- `brief --auto` starts the rate-limited background ingest in every case except `LEFTOFF_INTERNAL=1` and projects inside `LEFTOFF_HOME` or ignored projects;
- `LEFTOFF_QUIET` and `autoBrief.enabled = false` only stop the printing, and a quiet run doesn't mark the brief as shown.

Tests: `brief-auto` (quiet and disabled both start the ingest and print nothing; still due afterwards; internal starts none) and the shell tests (quiet still calls the CLI in zsh, bash 3.2 and fish).

### Part B

**`leftoff config [list | get <key> | set <key> <value>]`.** Strings print as they are, other values as JSON (`ignore.projects = ["/a","/b"]`). An unknown key says `unknown key: x. Run leftoff config list for the keys`; bad values show the validator's message; exit code 1 on any error. Nothing is written when a value is rejected.

**`leftoff status`.** Version and data folder; up to 10 projects, newest first, with last activity and event counts (`+N more`); the last ingest time and one line per collector (`✓ 12 new events`, `! timed out`, `– not found`).

**`leftoff forget (--project <path> | --all) [--yes]`.**
- Asks first, default no; `--yes` skips the question.
- It says how many events went and always adds: *Read positions (file paths and offsets, no content) are kept, so forgotten history is not read in again.*
- `--help` says the same.
- Needs exactly one of `--project` and `--all`.
- An unknown project says `No data stored for <path>.`

**`leftoff uninstall`.**
- Removes the leftoff block from each of `~/.zshrc`, `~/.bashrc` and `~/.config/fish/config.fish` that has one.
- Prints `claude plugin uninstall leftoff@leftoff` and `claude plugin marketplace remove leftoff`.
- If the folder `claude -p` polish runs left behind exists (`~/.claude/projects/<~/.leftoff/tmp with every non-alphanumeric character as "-">`), prints its path and `rm -r '<path>'`. It never deletes it.
- Asks "Also delete all leftoff data in <home>?" (default no). Yes removes `~/.leftoff`, including the shim.

**`leftoff setup`** (idempotent; in this order):
1. Creates the home folder (mode 700), writes the shim (`stableNodePath()` + the running `dist/cli.js`) and copies the three shell scripts. Both happen on every run.
2. Shell hooks: asks for the login shell (default yes) and for any other shell that has an rc file (default no, unless its block is already there). The answer is installed through `installShellHook` (`installed` or `already`) or `skipped`.
3. Claude Code: if the plugin is already installed, says so and doesn't ask; otherwise asks and installs from the repo folder. If `claude` is missing it prints the two manual commands.
4. Codex: says whether sessions were found.
5. Polish: shows a one-line note on what leaves your machine, then asks.
   - `ollama`: shows `ollama list`, says small models are faster on 8 GB machines, and lets you pick one of your installed models (no model names in the code). With no ollama or no models it stays off and says how to fix it.
   - `anthropic` and `openai`: need the key in the environment (never echoed) and a model name.
   - A choice whose prerequisites are missing falls back to off. The config is saved on every run, with the current choice as the default.
6. Catch-up ingest, 60 s budget, one progress line (`Read 12 Claude events, 3 Codex events, 840 commands, 25 commits`). A failing ingest doesn't fail setup.
7. Ends with `Open a new terminal to start.`

**`leftoff doctor`.** Each check is ✓, ✗ (fails, exit code 1) or `!` (warning, exit code 0):
- Node ≥ 22.15, platform, home folder permissions (700);
- database opens (a database from a newer leftoff fails here), config problems (by key name);
- CLI shim (`shim broken, run leftoff setup` when it doesn't run);
- shell hook in the login shell's rc file, copied scripts' version (warning), shell log or recent commands (warning, only when a hook is installed);
- Claude plugin installed, and a `session_start` in the last 7 days (warning), when Claude is found;
- Codex sessions folder readable, and the storage-format warning (activity in `$CODEX_HOME` in the last 7 days but no rollout file that new);
- malformed-line counts from the last ingest (warning);
- the polish provider is available (when not off);
- info: probe and scratch failures hidden in the last 7 days (Task 10 §9.3);
- the last 5 errors from the log, with a warning when any is from the last 7 days.

### Part C

- `maxWorkers: 4`: with the full CPU count, the ingest timing test (1.2 s budget) and the shim checks failed about 1 run in 3 once Task 15's tests were added.
- `shimStatus` waits 5 s for `<shim> --version` instead of 1 s. A node start takes about 100 ms; the rest is room for a busy machine, and a false "shim broken" is worse than a slow check.
- The provider timeout test's inner limit is 15 s instead of 5 s.

## 5. Design decisions

1. **`doctor` checks the login shell only** for the rc block. Setup doesn't store which shells you chose, and a shell you declined must not show as a failure.
2. **Plugin installed → no question.** Asking "install it?" when it's there would only teach you to click through.
3. **`setup` never edits a rc file until you've answered,** and a declined shell is left byte-for-byte as it was (tested).
4. **Warnings don't set the exit code.** Old copied scripts, a quiet week, or a Codex format change should be visible without making a script fail.
5. **`uninstall` deletes the data folder only on an explicit yes** (default no), and never the `claude -p` leftover folder.
6. **`displayCommand` is stored, not computed at render time,** so the comparison of contradictions and the "verified problem" logic of the auto brief keep working on the same strings.
7. **The error keeps at least 40 characters, the command at least 20.** Below that a line would be all command or all error.

## 6. Tests

### 6.1 RED

Each new test file failed first with "Cannot find module" (the commands), or with the function missing (`configProblems is not a function`, `repo.lastEventTs is not a function`, `hasShellHook is not a function`). The probe tests failed 15 of 16 new rows; the display tests failed before `displayCommand` and `clipMiddle` existed. Two tests were written after their code (the four-output cleaned-command check and the setup "plugin already installed" flow) and are covered by mutation checks instead.

### 6.2 Real data (read-only)

**Probes on your real data** (same clock as before): open problems 44 → 41, all in Orbit10 (18 → 15). Gone: a `tail … && ls -ld … && lsof` chain, an `sed -n` of a missing file, and the `ls -la … && find … && node --version && …` chain. LoopLint's five problems stay (their text got shorter, §6.3).

**`leftoff doctor` on your machine** (built CLI, nothing changed):
```
✓ Node ≥ 22.15 — v26.12.0   ✓ Platform — darwin   ✓ Home folder permissions   ✓ Database — schema 1
✓ Config   ✓ CLI shim   ✓ Shell hook (zsh)   ✓ Shell scripts — version 0.0.1
✓ Shell log — last command 24m ago   ✓ Claude Code plugin — last session 52m ago
✓ Codex sessions   ✓ Codex storage format   ✓ Malformed lines   ✓ Polish provider — off
✓ Hidden from briefs — 13 probe failures and 1 scratch failure in the last 7 days (stored, not shown)
! Recent errors — see ~/.leftoff/logs/leftoff.log
0 problems, 1 warning.        (exit 0)
```
The one warning is the four `user.email is not set` log lines from yesterday's first ingest (old git warnings, §9.3).

**`leftoff status`:** 18 projects tracked, 5132 events; last ingest 31 minutes ago, all four collectors ✓.

### 6.3 What the briefs look like now (snapshot copy of your DB)

```
Where you left off — Orbit10 (main) · last active 5d ago
  • 23 uncommitted files
  ✗ `ollama serve` — exit code 137 (+14 more problems)
Run `leftoff resume` for details
```
LoopLint's brief (`resume`) now reads, among others:
```
  ✗ `cargo test -p looplint_adapters` — failed (still failing)
  ✗ `cargo test … -- qualified_and_aliased run_agent_that_is star_import` — failed (still failing)
  ✗ `cargo test … --test dataflow | grep -vE "\.\.\. ok$"` — failed (still failing)
```
(The auto brief for LoopLint printed nothing on the copy: your real terminal already showed it, so it's marked shown.)

`brief --auto` latency through the shim, 20 runs against the copy: Orbit10 median 182 ms, p95 191 ms.

### 6.4 Mutation checks

About 35 mutations. Everything is caught except what is listed here, which I fixed:
- `clipMiddle`'s plain-cut fallback and its "no partial word" rule: the tests had no case that reached them (now two).
- A redundant `user_version` comparison in `doctor`: `openDb` already migrates or throws, so I removed the comparison and added a test for a database from a newer leftoff.
- `uninstall`'s default answer and the folder-name encoding (digits): the first test always answered explicitly, and the second compared with its own copy of the rule on a path that might have no digits. Both now have deterministic tests.
- One perl pattern of mine didn't match the file; I redid that mutation by hand with a backup. Source files were restored byte for byte after every mutation (compared).

### 6.5 Results

`npm run check`: tsc, eslint and prettier clean; five consecutive full runs passed (816 passed, 1 skipped, about 27 s each); the last run, after the final tests, is in §6.6. `npm run test:e2e` passes.

### 6.6 Final run

`npm run check` three times in a row after the last change: 824 passed, 1 skipped (the platform skip from earlier tasks), tsc/eslint/prettier clean. `npm run test:e2e`: 3 passed. `dist/` rebuilt, so your live hooks run the new code.

## 7. Edge cases and failure handling

- **`setup` with no rc file** for the login shell: the file is created with just the block. No other rc file is created.
- **`setup` re-run:** same rc file bytes, same config bytes, `already` for existing blocks.
- **Failing ingest in `setup`:** logged, a one-line message, setup still ends with "Open a new terminal to start."
- **`ollama list` failing or empty:** polish stays off with the `ollama pull` hint.
- **`forget` on an unknown project:** nothing deleted, says so.
- **`doctor` with a folder where the database should be, or no home folder:** the checks fail with hints; it never throws.
- **`config set` with a bad value:** exit code 1, file untouched.
- **`uninstall` twice:** the second says no block was found.

## 8. Deviations from the plan

- `Prompter` has `say`; `SetupEnv` has optional seams; `SetupResult` is `{ shellHooks, plugin, polish, progress }`.
- Doctor checks can be warnings (`warn`) and the result carries `recentErrors`; `renderDoctor` is new.
- The progress line counts events (the report has inserted events, not sessions): `Read 12 Claude events, …`.
- The shim check waits 5 s instead of 1 s.
- `status` caps the project list at 10 and says `+N more`.
- Added to the unit config: `maxWorkers: 4`.
- `OpenProblem.command` changes meaning (display form), and `Repo` gets two small queries.

## 9. Open questions and risks

1. **A chain of several real steps keeps its filter and setup parts.** For example `cargo fmt --all && cargo clippy … ; cargo test --workspace | grep …` is shown whole (middle-shortened) in LoopLint's brief. That is the "chains match only themselves" rule. A prettier display would show only the failing step, but the exit code doesn't say which step failed. Your call.
2. **`doctor` only checks the login shell's rc file.** A second shell you chose in `setup` isn't verified. `setup` could store the chosen shells in the config; I left it.
3. **The `Recent errors` warning on your machine is accurate but stale:** four old `user.email is not set` lines from your first ingest keep it at a warning for 7 days. Do you want those logged once per repo instead of once per ingest, or leave them?
4. **`setup`'s plugin source is the repo folder** (`dirname(shellDir)`) while you're dogfooding. For a published package it must become the GitHub name (Task 18).
5. **`~/.bashrc` on macOS:** bash login shells read `~/.bash_profile`. Setup follows the plan (`.bashrc`) and offers it only when the file exists.
6. **Two tests are timing-sensitive by nature** (the ingest budget test, the hook budget test); they now pass reliably at 4 workers, but Task 16's performance work should own them.

## 10. Commit

To be filled in by Task 16's commit (B11). The commit message is `feat(cli): setup, doctor, status, forget, config, uninstall`.
