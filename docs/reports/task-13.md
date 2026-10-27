# Task 13: Claude Code plugin and hook commands

This commit has three parts:

- **A.** Your answers to Task 12 §9: per-provider timeouts, a lock that outlives the slowest provider, the local-model notice, and plan notes for Tasks 15 and 17.
- **B.** Task 13 itself: the plugin and marketplace manifests, `leftoff hook <name>`, the CLI shim, and the plugin installer.
- **C.** Fixes from the first dogfooding: the real session showed the brief was mostly noise. These are display fixes and new §1.7 rules (scratch work, resolution by program + subcommand with file scoping, filtered exit codes, `git diff` probes, the claimed-done sentence), all measured on your real data.

§6.2 shows the hooks run against real fixture data through the built CLI. §6.3 is the real-session check in your Claude Code (plan step 4b), plus the before/after numbers on your real data.

## 1. Goal

**Part A (your answers):**
1. **Background summarize:** `ollama` gets 180 s, every other provider 60 s.
2. **Foreground `resume --polish`:** 60 s for all. When ollama is about to run, it prints `Generating summary with a local model, this can take a minute…` to stderr.
3. **Lock bug fixed:** the summarize lock TTL is now *the longest provider timeout + 60 s* (240 s). A test proves a second summarize can't start while a slow ollama call is still running.
4. **Plan notes added:**
   - Task 15 setup: for Ollama, say small models are faster on 8 GB machines and show `ollama list`; no hardcoded model names.
   - Task 15 uninstall: print the `~/.claude/projects/…leftoff/tmp` folder and the command to remove it; never delete it.
   - Task 17 checklist: test Ollama polish with a warm model on your 8 GB M1.

**Task 13 (plan):**
- `plugin/.claude-plugin/plugin.json`, `plugin/hooks/hooks.json`, and `.claude-plugin/marketplace.json` (marketplace `leftoff`, plugin `leftoff@leftoff`).
- `runHook` for `claude-session-start`, `claude-stop`, `claude-session-end`.
- `installShim` and `shimStatus`.
- `installClaudePlugin` and `claudePluginInstalled`.
- The e2e test against the built CLI.

**Part C (your decisions after the real session):**
- **Display.**
  - List items are never dropped: at most 5 per list (3 in the agent context when it must), each shortened, then `+N more`.
  - Every displayed text is one line; a multi-line command shows its first line + ` …`.
  - Quotes are cut at word boundaries.
  - `VAR=value;` and `VAR=value &&` are statements, not env prefixes.
- **Scratch work is not an open problem:**
  - heredocs, `python -c` / `node -e` / `bash -c`, multi-line commands, and pipelines starting with a text tool;
  - stored with `data.scratch = true`, and also classified when read for older events;
  - agents only.
- **Resolution by program + subcommand** (`commandKey`).
  - Setup steps and runner prefixes are skipped. Chains and multi-line commands match only themselves.
  - **File-scoped:** a failure with file arguments is resolved only by a run with the same files or none.
- **Filtered exit codes:** in a single pipeline ending in a text filter (`grep`, `rg`, `head`, …), the output decides pass or fail, not the exit code. A filtered run counts as the command before the filter.
- **Probes:** `git diff` (any form) with exit 1 means "differences found". Probes are also decided again when reading.
- **Claimed done:** the quote is the sentence with the done-word, about 100 characters at most.
- **Plan notes:** Task 16 measures real hook latency (median and p95 over 20 runs, not under parallel load).

## 2. Files

| File | Purpose |
|---|---|
| `src/polish/chain.ts` | **A:** `polishWith(…, timeoutFor, onStart?)`, a timeout per provider name, and a callback just before each provider runs |
| `src/polish/summarize.ts` | **A:** `BACKGROUND_TIMEOUTS` (`ollama` 180 s), exported `SUMMARIZE_LOCK_TTL_MS` (longest + 60 s); `PolishDeps.timeoutFor` / `onStart` replace `timeoutMs` |
| `src/cli/commands/resume.ts`, `src/cli/index.ts` | **A:** `notify` (live stderr lines) and a `providers` test seam; the local-model notice. **B:** hidden `hook <name>` command (stdin capped at 1 s; exits right after writing) |
| `docs/leftoff-implementation-plan.md` | **A:** §1.9 timeouts and notice; §1.11 lock TTL; Task 12 interface; Task 15 setup and uninstall notes; Task 17 checklist item |
| `plugin/.claude-plugin/plugin.json` | **New:** plugin manifest (`leftoff`, 0.0.1, MIT) |
| `plugin/hooks/hooks.json` | **New:** `SessionStart` (matcher `startup\|clear\|compact`, 5 s), `Stop` (2 s), `SessionEnd` (2 s); the shim-then-PATH command from the plan |
| `.claude-plugin/marketplace.json` | **New:** marketplace `leftoff`, plugin source `./plugin` |
| `src/cli/commands/hook.ts` | **New:** `runHook` |
| `src/install/shim.ts` | **New:** `installShim`, `shimStatus` |
| `src/install/claude-plugin.ts` | **New:** `installClaudePlugin`, `claudePluginInstalled`, `manualPluginCommands` |
| `tests/cli/hook.test.ts`, `tests/install/{claude-plugin,shim}.test.ts`, `tests/e2e/hook-cli.e2e.test.ts` | **New** |
| `tests/polish/{chain,summarize}.test.ts`, `tests/cli/resume.test.ts` | **A** tests |
| `src/collectors/scratch.ts` | **New (C):** `isScratchCommand` and its lists |
| `src/model/event.ts` | **C:** the `VAR=value;` fix; `commandKey`, `commandFiles`, `pipelineHead`, `endsWithFilter`, `withoutFilters` |
| `src/brief/facts.ts` | **C:** scratch, probe and filter checks when reading; `resolves` (key + files); one-line attempts; word-boundary quotes; `claimSentence` |
| `src/collectors/{claude,codex}.ts`, `src/collectors/test-failures.ts`, `src/collectors/probes.ts` | **C:** `data.scratch`; `isFilteredExit`; masked test failures also behind filters; `git diff` probe |
| `src/render/text.ts` | **New (C):** `clip` (word boundary) and `capItems` (`+N more`) |
| `src/render/terminal.ts`, `src/render/markdown.ts` | **C:** lists capped at 5; agent-context list shapes (5×300 → 5×160 → 3×120 → 3×80) |
| `tests/collectors/scratch.test.ts` | **New (C):** scratch and `commandKey` cases, including the ones found on your data |
| `tests/brief/facts.test.ts`, `tests/collectors/{claude,codex,probes}.test.ts`, `tests/model/event.test.ts`, `tests/render/{terminal,agent-context}.test.ts` | **C** tests |

## 3. Interfaces produced

```ts
// Part A
function polishWith(providers, prompt, config, timeoutFor: (name) => number, onStart?: (name) => void);
const SUMMARIZE_LOCK_TTL_MS: number;                 // max provider timeout + 60 s = 240 000
interface PolishDeps { …; timeoutFor?: (name) => number; onStart?: (name) => void }
interface ResumeOptions { …; notify?: (line: string) => void; providers?: PolishProvider[] }
// Task 13
type HookName = 'claude-session-start' | 'claude-stop' | 'claude-session-end';
function runHook(name: HookName, stdin: string, deps?: { ingest?; spawnSummarize? }): Promise<{ stdout: string }>;
function installShim(nodePath: string, cliPath: string): void;
function shimStatus(): { exists: boolean; nodePath: string | null; cliPath: string | null; works: boolean };
function installClaudePlugin(source: string, print?: (line: string) => void):
  Promise<'installed' | 'already' | 'claude-not-found' | 'failed'>;
function claudePluginInstalled(): Promise<boolean>;
function manualPluginCommands(source: string): string[];
// Part C
function isScratchCommand(raw: string): boolean;
function commandKey(cmd: string): string;          // program + subcommand
function commandFiles(cmd: string): string[];      // file and path arguments, sorted
function endsWithFilter(cmd: string): boolean;     // single pipeline into a text filter
function withoutFilters(cmd: string): string;
function isFilteredExit(command: string, output: string): boolean;
function clip(text: string, max: number): string;  // word boundary
function capItems(items: string[], max: number): string[];
```

## 4. How it works

**Hooks.** `runHook` returns empty output at once when `LEFTOFF_INTERNAL=1`, without opening the database. Otherwise it:
1. parses Claude Code's stdin JSON;
2. records nothing without a `cwd`;
3. resolves the project root;
4. skips projects inside `LEFTOFF_HOME` (polish runs) and projects matched by `ignore.projects`.

Any error is logged and gives empty output. Then, per hook:
- **`claude-session-start`:** ingests for this project (1000 ms), builds the facts, and renders `renderAgentContext`, using a cached polished paragraph if its facts still match. All of this runs inside a 2000 ms budget.
  - It then records `session_start` with `{ transcriptPath, source }`. Recording comes after the brief, so the brief is about the work before this session.
  - It prints `{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":…}}`, or nothing when the project had no events or the budget ran out.
- **`claude-stop`:** records `checkpoint` with `{ transcriptPath }`.
- **`claude-session-end`:** records `session_end` with `{ reason }`, then **always** calls `spawnBackgroundSummarize(root)` (R-B1).

The CLI command reads stdin for at most 1 s, writes the output, and calls `process.exit(0)` in the write callback. Work abandoned past the budget, such as a slow ingest, can't keep the hook alive past Claude Code's timeout.

**Hook command** (in `hooks.json`, exactly the plan's): use `${LEFTOFF_HOME:-$HOME/.leftoff}/bin/leftoff` if it's executable, otherwise `leftoff` on PATH, otherwise nothing. Always `exit 0`.

**Shim.** `installShim` writes `#!/bin/sh` and `exec '<node>' '<cli>' "$@"`. The paths are single-quoted, with `'` escaped. The file is written to a temp file, then `chmod 700` and renamed into place.

`shimStatus` parses that line back. `works` means both paths exist and `<shim> --version` exits 0 within 1 s.

**Installer.** `installClaudePlugin(source)`:
- returns `claude-not-found` when `claude` isn't on PATH;
- returns `already` when `claude plugin list --json` lists `leftoff@leftoff`;
- otherwise runs `claude plugin marketplace add <source>`, then `claude plugin install leftoff@leftoff`.

If either step fails, it prints both commands for you to run and returns `failed`.

### Part C: when a failure counts (in order)
1. **Probes** (the list from §1.7, now with `git diff`) and **scratch** commands from agents are stored but skipped. Both are decided again when reading, so events stored before these rules follow them.
2. **Filtered pipelines.** For an agent's single pipeline ending in a text filter, the output decides: it's a failure only if it matches a failed-test pattern. Otherwise it's a success of the command before the filter. A `cd …` step in front is fine; a chain like `a && b | grep` is not decided this way, because the exit code may be `a`'s.
3. **Resolution.** A success resolves a failure when their `commandKey`s are equal, and, if the failure has file arguments, the success has the same files or none.

## 5. Design decisions

1. **`session_start` is recorded after the brief is built.** That way the new, empty session is never the "most recent session" in the brief's window.
2. **The hook CLI exits explicitly** (`process.exit(0)` once stdout is flushed). On macOS, writes to a pipe are asynchronous, so the exit waits for the write callback.
3. **Hooks skip `LEFTOFF_HOME` and `ignore.projects`,** the same rules the collectors use. This is a second guard next to `LEFTOFF_INTERNAL`.
4. **`installClaudePlugin` takes a `print` callback** (stderr by default) for the two fallback commands. `manualPluginCommands` lets `setup` (Task 15) show them too.
5. **`claudePluginInstalled` reads `claude plugin list --json`.** I checked its shape on this machine: a list of `{ id, version, scope, enabled, … }`.
6. **The live notice uses `notify`, not the returned `stderr`.** The polish-off hint is a result, so it's returned at the end. The local-model notice has to appear *before* the wait, so it's written as it happens.
7. **(C) Scratch, filters and probes are also decided when reading.** Your database was filled before these rules, and stored events can't be re-ingested. Classifying again when reading makes old and new events behave the same.
8. **(C) Scratch and filtered exits apply to agents only.** Your own shell commands have no recorded output, so a test pattern can't be checked, and they are your deliberate commands.
9. **(C) Keys are compared for equality, as you specified.** A narrower passing run (`vitest run tests/b.test.ts`) also resolves a broader failure (`vitest run`), because both keys are `vitest run`.
10. **(C) Rules refined after checking your data,** each with a test:
    - setup steps and runner prefixes skipped;
    - chains and multi-line commands match only themselves;
    - the filter rule only for single pipelines (a Voice_Model chain that exited 128 was otherwise hidden);
    - the file rule restricts only failures that have file arguments;
    - a filter decides in both directions (a `grep` that exits 0 because it found `FAIL` lines is a failed test run, extending Task 12's `| tail` rule).
11. **(C) Notes are not capped** (P11: your notes are always shown). `--md` and `--json` keep every item.
12. **Polish was switched back to `off`** after the step 6 check, so session ends don't start `claude -p` calls without your say-so.
13. **Test timeouts.** One test runs seven `sh` commands; it gets 20 s, because it hit the 5 s default once under full-suite load (745 ms alone). The session-start budget test asserts at least 1.9 s and under 4 s.

## 6. Tests

### 6.1 Flags and manifests re-checked (Claude Code 2.1.311, no AI calls)

- `claude plugin --help`, `claude plugin marketplace add --help` and `claude plugin install --help` confirm `marketplace add <source>` and `install <plugin@marketplace>`.
- `claude plugin validate plugin` → `✔ Validation passed`.
  - The plugin-directory submission checks (not part of the result) ask for a README and an icon. Those are Task 18 (docs and release).
- `claude plugin validate .` → `✔ Validation passed`. I added a marketplace `description` after its one warning.

### 6.2 Hooks on real fixture data, built CLI, no install

Scratch `LEFTOFF_HOME`, with the Claude fixture in a scratch `CLAUDE_CONFIG_DIR`:

```
$ printf '%s' '{"session_id":"new-1","transcript_path":"/tmp/x.jsonl","cwd":"/private/tmp/leftoff-fixture","hook_event_name":"SessionStart","source":"startup"}' \
    | node dist/cli.js hook claude-session-start
exit=0 took=0.20s bytes=1031
SessionStart
## Previous session in this project (from leftoff)

Project: leftoff-fixture · branch main · last active 20h ago

Last request: Reply with exactly: All tests pass, done.

The agent said "All tests pass, done.", but:
- `npx --no-install eslint .` — npm error npx canceled due to missing packages and no YES option: ["eslint@10.13.0"] (still failing)
- `npm run lint` — npm error Missing script: "lint" (still failing)
…
Suggested next step: Verify: `npx --no-install eslint .` still failing

This is an automatic summary of earlier work. Verify against the code before relying on it.
```

**SessionEnd child survives the hook's exit.** First I added a Codex session the database hadn't seen. Then:
- `hook claude-session-end` exited 0 in **0.15 s**.
- Right after, `pgrep` still showed `node …/dist/cli.js internal summarize --project /private/tmp/leftoff-fixture`.
- Once it finished, the database had the Codex project's 33 events, which only that child could have ingested. The lock was released and nothing was logged.

### 6.3 Real-session check in your Claude Code (plan step 4b)

**Setup (approved by you):**
- shim `~/.leftoff/bin/leftoff` → `/Users/apple/leftoff/dist/cli.js` (`shimStatus().works = true`);
- `claude plugin marketplace add /Users/apple/leftoff` and `claude plugin install leftoff@leftoff` (user scope);
- catch-up through `leftoff internal summarize`: **2.6 s**, 4,894 events, 17 projects. Later runs found nothing new.

**Your session (4b).** It started cleanly, with no hook error or slowdown, and Claude quoted the injected context.
- Recorded: `session_start` (10:35:15, `source: startup`, with the transcript path), `checkpoint` (10:36:52) and `session_end` (10:38:16, `prompt_input_exit`).
- I briefly reported `session_end` as missing. My first query ran before you had exited.

**Background child.** The installed SessionEnd command, run with your real `HOME`, returned in **0.32 s**. Its background ingest finished afterwards, and no lock was left.

**Polish recursion check (one `claude -p`).** With polish set to `claude-cli`, `leftoff internal summarize --project /Users/apple/leftoff` took **13.0 s** and saved a 742-character summary.
- No events were recorded after the baseline, and no events exist under `~/.leftoff`.
- The only new `~/.claude/projects` folder is `-Users-apple--leftoff-tmp`, with an empty `memory/` inside.
- Polish was set back to `off` straight after.

**What dogfooding found.**
- The brief was mostly noise: 17 "open problems" for this repo were my own one-off commands.
- The agent context's lists collapsed to `…and 16 more` with no items.
- Text with newlines broke lines, and quotes were cut mid-word.

Part C fixes these. Numbers below, all read-only against `~/.leftoff/leftoff.db`, with the same fixed clock (2026-10-27T10:45Z):

| Project | Before | After |
|---|---|---|
| ~/Orbit10 | 22 | 18 |
| ~/leftoff | 17 | 2 |
| ~/LoopLint | 13 | 6 |
| ~/dynavec | 8 | 3 |
| ~/.xmatrix-management/1eb15c… | 3 | 2 |
| ~/Voice_Model | 2 | 2 |
| ~/Earthquake-Detection-… | 2 | 2 |
| /private/tmp/leftoff-fixture, /private/tmp/leftoff-codex-fixture | 2 + 2 | 2 + 2 |
| ~/.xmatrix-management/750fac…, a Claude scratch workspace | 1 + 1 | 1 + 1 |
| **Total** | **73** | **41** |

**Real problems that disappeared:** none that I could find. My first key rule did hide real ones; each was fixed and is back in the "after" column:
- LoopLint's `cargo test -p looplint_adapters` (hidden by a shared `source "$HOME/.cargo/env" &&` prefix);
- Earthquake's `uv run ruff check src/dasquake/streaming.py` (UP035) (hidden by a shared `uv run` prefix);
- Voice_Model's `git status && git diff … | sed` chain, which exited 128 (hidden by the first filter rule).

Problems cleared by a later success, each checked:
- `pnpm exec tsc --noEmit --pretty false` by a later passing `tsc --noEmit --strict …`;
- `npx vitest run --project unit | grep -E -A15 "FAIL "` (a real test failure at 10:25) by the passing run at 10:26.

The rest disappeared as scratch: heredocs, `python3 - <<EOF`, `rg … | sort`, multi-line scripts, and `nl … | sed`. The file rule kept `prettier --write A`, `ruff format --check A B` and an `rg` on another path open.

**The leftoff brief, before** (excerpt; 115 lines in total with the agent context):

```
Agent said done, but
  claude said: "…alue` before `;` is its own statement, not a prefix, so it shouldn't be stripped.
…
  ✗ `ls -t ~/.claude/debug | head -5; f=$(ls ~/.claude/debug/1ac17637* | head -1); … (still failing)
  ✗ `; export LEFTOFF_HOME=$R/lhome CLAUDE_CONFIG_DIR=$R/claude CODEX_HOME=$R/codex… (still failing)
  ✗ `python3 - <<'EOF' p='src/cli/index.ts' s=open(p).read() s=s.replace("import { … (still failing)
    tried: mkdir -p plugin/.claude-plugin plugin/hooks .claude-plugin && python3 - <<'EOF'
import j…
  … 13 more like these
```

The agent context then had `- …and 16 more` with no items in every list.

**After** (62 lines in total):

```
Where you left off — leftoff (main) · last active just now

Agent said done, but
  claude said: "…bugs (dropped list items and newlines) are fixed in this commit or left for Task…
  ✗ `bash /private/tmp/claude-501/-Users-apple--claude-spares-spare-qPCfF3/7dd00b1d… (still failing)
    tried: grep -n "^## \|^### " docs/reports/task-11.md | head -40 && sed -n '/^### 6.1/,/^###…
  ✗ `npx vitest run --project unit tests/polish/providers.test.ts | grep -E -A12… (still failing)
    tried: sed -n 1,12p tests/polish/providers.test.ts | head -12; perl -0pi -e 's/import \{\n…

Done
  • Edited 10 files: tests/polish/prompt.test.ts, tests/polish/chain.test.ts, tests/polish/provider…

Unfinished
  • .claude-plugin/ (untracked)
  • docs/leftoff-implementation-plan.md (modified)
  • docs/reports/task-13.md (untracked)
  • plugin/ (untracked)
  • src/brief/facts.ts (modified)
  • +31 more

Next step
  → Verify: `bash /private/tmp/claude-501/-Users-apple--claude-spares-spare-qPCfF3/7dd00b1d-288b-45…

Sources: claude ✓  git ✓  shell ✓  codex ✓
```

Both remaining problems follow the rules:
- the `bash mut12b.sh; …` chain only matches itself;
- the `providers.test.ts` run failed for real at 09:51, and no later run of that file or of the whole suite was recorded (my later checks were chains or `npm run check`).

In the agent context every list now shows items, each one line, with `+N more`.

### 6.4 RED

- **Part A:** four tests failed:
  - `polishWith` had no per-provider timeout or `onStart`;
  - background ollama got 60 s;
  - the lock test: `SUMMARIZE_LOCK_TTL_MS` was undefined;
  - no notice.
- **Task 13:** the three new unit files failed with `Cannot find module …/hook.ts`, `…/claude-plugin.ts` and `…/shim.ts`. The manifest tests failed on the missing files.
- **Written after the code:** the test for "a session inside LEFTOFF_HOME or an ignored project records nothing". Mutations H10 and H11 show it catches the bug.

**Part C:** every new test failed first:
- the scratch module was missing;
- `R=/x; export` became `; export`;
- lists ended in `…and 16 more`;
- no `+N more`;
- cuts were mid-word;
- `npx vitest run` did not resolve `vitest run tests/a.test.ts`;
- scratch failures were open;
- attempts kept newlines;
- quotes were not cut at word boundaries;
- `git diff` was not a probe;
- filtered passes were failures;
- file scoping was missing;
- the claim was not reduced to its sentence;
- chains through a filter were hidden;
- filtered keys were missing.

Two tests were written after the code: the short-list agent-context test (after S14 survived) and the `LEFTOFF_HOME` / ignore hook test. The mutation runs below show they catch the bug.

### 6.5 Mutation checks (bash script, per-file backups, byte-compared after each restore)

| # | Mutation | Caught |
|---|---|---|
| F1 | lock acquired with the old 120 s | yes (the slow-provider test) |
| F2 | background summarize without per-provider timeouts | yes |
| F3 | background ollama 60 s | yes |
| F4 | notice for every provider | yes |
| F5 | `onStart` never called | yes |
| H1 | no `LEFTOFF_INTERNAL` guard | yes |
| H2 | no "no prior events" check | yes |
| H3 | session-start budget 200 ms | yes |
| H4 | session-end doesn't spawn summarize | yes |
| H5 | matcher also includes `resume` | yes |
| H6 | shim paths not quoted | yes |
| H7 | `shimStatus.works` without running `--version` | yes |
| H8 | installer skips the "already installed" check | yes |
| H9 | hook command without `exit 0` | yes |
| H10 | hooks don't skip `LEFTOFF_HOME` | yes |
| H11 | hooks don't skip `ignore.projects` | yes |
| H12 | installer ignores a failing step | yes |
| S1 | scratch not decided when reading | yes |
| S2 | your shell commands also treated as scratch | yes |
| S3 | `commandKey` = whole command | yes |
| S4 | runner prefixes not skipped | yes |
| S5 | setup steps not skipped | yes |
| S6 | multi-line command gets a short key | yes |
| S7 | lists not capped | yes |
| S8 | no word-boundary cut | yes |
| S9 | quote start not moved to a word | yes |
| S10 | multi-line attempt joined into one line | yes |
| S11 | `VAR=value;` stripped | yes |
| S12 | multi-line not scratch | yes |
| S13 | heredoc not scratch | yes |
| S14 | first list shape 50 × 3000 | first survived → added the short-list test → yes |
| R1 | filtered pass not decided when reading | yes |
| R2 | Claude collector ignores filtered exits | yes |
| R3 | Codex collector ignores filtered exits | yes |
| R4 | file arguments ignored | yes |
| R5 | filtered pass resolves with the filter still on | yes |
| R6 | probes not decided when reading | yes |
| R7 | `git diff` not a probe | yes |
| R8 | claim not reduced to its sentence | yes |
| R9 | no `…` at a cut start | yes |
| R10 | filtered exit ignores test output | yes |

### 6.6 Tests

`npm run check`: **44 files, 684 passed, 1 skipped** (the fish raw-tab test, by design). That is 592 before, plus 4 for Part A (chain 1, summarize 2, resume 1), plus 67 for Part C, plus 21 for Task 13:
- hook 10
- plugin, manifests and hook command 8
- shim 3

`npm run test:e2e`: **2 passed**:
- real CLI: `hook claude-stop` on empty stdin;
- an unknown hook name.

The plan's 11 named tests are all present (hook ×6, manifests, hook command, shim ×2, e2e).

## 7. Edge cases and failure handling

- **Bad stdin:** garbage, an empty string, a JSON array, or a missing `cwd` → empty output, nothing recorded.
- **Slow session start:** a session-start ingest that never finishes → empty output after 2 s. `session_start` is still recorded, and the process exits even though the ingest is still pending.
- **Unknown hook name:** exit 0, silent (e2e).
- **Shim paths:** paths with spaces and quotes work (the test's temp folder has both). A missing CLI path or a failing CLI → `works: false`.
- **`claude plugin list`:** a non-zero exit or output that isn't JSON → "not installed".

## 8. Deviations from the plan

- **`runHook`:** takes an optional `deps` test seam (`ingest`, `spawnSummarize`).
- **`installClaudePlugin`:** takes an optional `print`. `manualPluginCommands` is new.
- **Hooks:** they also skip `LEFTOFF_HOME` and `ignore.projects` (§5.3).
- **Part A:** `polishWith` and `PolishDeps` change from one `timeoutMs` to `timeoutFor`. `ResumeOptions` gains `notify` and `providers`.
- **Part C refinements beyond the literal rules,** all from your real data (§5.10):
  - setup steps and runner prefixes skipped in the key;
  - chains and multi-line commands match only themselves;
  - the filter rule only for single pipelines;
  - filters decide in both directions;
  - a filtered run counts as the command before the filter;
  - `nl` added to the text tools;
  - `sh -c`, `zsh -c` and `python3 -c` treated like `bash -c` and `python -c`.

## 9. Open questions and risks

1. **A false "claimed done".** In the leftoff brief the claim is my question *"…are fixed in this commit or left for Task 17's fix loop"*. The claim regex matches "fixed" in a conditional. That belongs to Review Focus 6, for Task 17.
2. **Remaining noise** under the current rules:
   - chains of look-around commands that aren't all probes (`ls -la x && find … && node --version`);
   - one-off script runs (`bash scratchpad/mut12b.sh; …`);
   - `Tests failed: …` events whose command was dropped by the 4 KB event limit (the command text is then unknown).
3. **The shim pins Homebrew's versioned node path** (`/opt/homebrew/Cellar/node/26.12.0/bin/node`). A `brew upgrade node` breaks the hooks until `leftoff setup` rewrites the shim. `doctor` (Task 15) should flag it.
4. **Plugin directory checks** (README, icon) are left for Task 18.
5. **The Task 10 §9.3 probe-count `doctor` line** is still open (Task 15).

## 10. Commit

`1067a0e feat(claude): plugin hooks inject brief and record sessions` (hash filled in by Task 14's commit, B11).
