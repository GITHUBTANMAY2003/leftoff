# Task 12: AI polish providers and background summarize

This commit has three parts:

- **A.** Your answers to Task 11 §9.1/§9.2: long lines keep "(still failing)", and commands are normalized before comparison and display.
- **B.** Task 12 itself: the five polish providers, the provider chain, `polishNow`, the background summarize, and `leftoff resume --polish`.
- **C.** Your follow-ups after reviewing B: the polish-off hint (§9.2), and `think: false` plus `<think>` stripping for Ollama.

§6.1 shows the re-rendered real-fixture briefs. §6.2 shows the two real AI calls (one `claude -p`, one Ollama).

## 1. Goal

**Part A (your answers):**
1. **Cut inside the error, keep the suffix.** A long contradiction is cut before ` (still failing)`, so the suffix always shows. Loose ends already kept its endings (`(2 attempts)`, the `!` counts).
2. **Normalize commands** for comparison, and show the normalized form in the brief. §1.7's rule now strips:
   - redirections: `2>&1`, `>/dev/null`, `2>/dev/null`, `&>/dev/null`, `>file.log` (also `>>`);
   - a leading `cd <dir> &&` (repeated steps too);
   - trailing `| tail …`, `| head …`, `| cat`, `| less`.

   Your three required tests are in (§6.3).

**Task 12 (plan):**
- `PolishProvider` and the five providers: `claude-cli`, `codex-cli`, `ollama`, `anthropic`, `openai`.
- `buildPolishPrompt`, `validatePolish`, `pickProviders`, and a chain that falls through on errors, timeouts and invalid output.
- `polishNow` with the facts-hash cache.
- `runInternalSummarize`, which takes a lock, always ingests (20 s budget), and polishes only when polish is on (R-B1).
- `spawnBackgroundSummarize` and the hidden `leftoff internal summarize --project`.
- `leftoff resume --polish` runs `polishNow` synchronously (plan Task 10 note).

## 2. Files

| File | Purpose |
|---|---|
| `src/model/event.ts` | **A:** quote-aware `tokenize`; `normalizeCommand` strips redirections, `cd … &&` and trimming pipes; new `endsWithTrimmingPipe` |
| `src/collectors/test-failures.ts` | **A:** `isMaskedTestFailure(command, output)` |
| `src/collectors/claude.ts`, `src/collectors/codex.ts` | **A:** a command that exits 0 through a trimming pipe, with failing-test output, is recorded as `test_failed`; `testFailed` helper |
| `src/render/terminal.ts` | **A:** `fitKeepingTail`; contradictions keep ` (still failing)` |
| `src/polish/types.ts` | **New:** `PolishProvider` |
| `src/polish/prompt.ts` | **New:** `buildPolishPrompt` (instruction + facts JSON ≤ 8000 chars, shrunk step by step), `validatePolish`, `MAX_FACTS_CHARS` |
| `src/polish/chain.ts` | **New:** `allProviders`, `pickProviders`, `polishWith` (per-provider timeout, errors logged) |
| `src/polish/summarize.ts` | **New:** `polishNow`, `runInternalSummarize`, `spawnBackgroundSummarize` |
| `src/polish/providers/run-cli.ts` | **New:** `onPath`, `runCli` (stdin prompt; cwd `~/.leftoff/tmp`; `LEFTOFF_INTERNAL=1`; SIGKILL on timeout) |
| `src/polish/providers/claude-cli.ts` | **New:** `claude -p --no-session-persistence --tools "" --output-format text` |
| `src/polish/providers/codex-cli.ts` | **New:** `codex exec --ephemeral --skip-git-repo-check -s read-only -o <file> -` |
| `src/polish/providers/http.ts` | **New:** `postJson` with `AbortSignal.timeout` |
| `src/polish/providers/{ollama,anthropic,openai}.ts` | **New:** HTTP providers; base URL is a parameter, so tests use a local server. **C:** Ollama sends `think: false` and strips `<think>…</think>` |
| `src/cli/commands/internal.ts` | **New:** `runInternalSummarizeCommand` (silent; errors go to the log) |
| `src/cli/commands/resume.ts`, `src/cli/index.ts` | `--polish`; hidden `internal summarize`. **C:** `runResume` returns an optional `stderr` line (the polish-off hint), and `print` writes it to stderr |
| `docs/leftoff-implementation-plan.md` | §1.7 normalization rule and the masked test-failure rule; §1.8 suffix rule |
| `tests/polish/{prompt,chain,providers,summarize}.test.ts`, `tests/cli/internal.test.ts` | **New** |
| `tests/model/event.test.ts`, `tests/brief/facts.test.ts`, `tests/collectors/{claude,codex}.test.ts`, `tests/render/terminal.test.ts`, `tests/brief/fixtures.test.ts`, `tests/cli/resume.test.ts` | Fold-in tests; the fixture expectation loses `2>&1`; `--polish` test |

## 3. Interfaces produced

```ts
interface PolishProvider { name: PolishProviderName; available(config: Config): Promise<boolean>; polish(prompt: string, timeoutMs: number): Promise<string> }
const MAX_FACTS_CHARS = 8000;
function buildPolishPrompt(f: BriefFacts): string;
function validatePolish(text: string): string | null;            // trimmed; null if empty or > 1200
function allProviders(config: Config): Record<PolishProviderName, PolishProvider>;
function pickProviders(config: Config, all?: Record<PolishProviderName, PolishProvider>): PolishProvider[];
function polishWith(providers, prompt, config, timeoutMs): Promise<{ polished: string; provider: PolishProviderName } | null>;
function polishNow(root: string, deps: { repo; config; now; working: WorkingState | null; providers?; timeoutMs? }):
  Promise<{ polished: string | null; provider: string | null }>;
function runInternalSummarize(root: string, deps?: { providers?: PolishProvider[] }): Promise<void>;
function spawnBackgroundSummarize(root: string, cliPath = process.argv[1]): void;
// Part A
function normalizeCommand(cmd: string): string;                  // rule extended
function endsWithTrimmingPipe(cmd: string): boolean;
function isMaskedTestFailure(command: string, output: string): boolean;
function fitKeepingTail(prefix: string, text: string, tail: string): string;
```

## 4. How it works

### Normalization (A)
`tokenize` splits a command line into words and operators (`&&`, `||`, `|`, `;`, `&`, and output redirections such as `2>&1`, `>`, `>>`, `&>`). Text inside `'…'` or `"…"` stays in its word, so `echo "a > b"` has no redirection.

`normalizeCommand` then works through the tokens:
1. Drops each redirection and the file it writes to. `2>&1` and `>&2` have no file.
2. Repeats until nothing changes:
   - drop a leading `VAR=value`;
   - drop a leading `cd <dir> &&`;
   - drop a trailing `| tail …` / `| head …` (any arguments), or a bare `| cat` / `| less`.
3. Rejoins the kept tokens with the original spacing, so `a&&b` is unchanged.

A command made only of stripped parts (for example `cd /x` alone) is left as it is.

**Masked test failures.** `npm test 2>&1 | tail -20` exits with tail's code, so it can exit 0 while the tests fail. When an agent command ends in a trimming pipe, exits 0, and its output matches a failed-test pattern, the collectors record `test_failed` instead of a successful `command`. Without such a pipe, exit 0 is trusted (§5).

### Polish (B)
`polishNow`:
1. Builds the facts (the same `buildFacts` as `resume`).
2. Does nothing for a project with no recorded activity.
3. Returns the saved summary when its facts hash matches and it has text.
4. Otherwise builds the prompt and asks `polishWith`.

`polishWith` goes through the providers in order:
- skips an unavailable one;
- races each `polish` call against the timeout (60 s);
- validates the reply;
- returns the first valid one, logging each failure.

Only a successful result is saved (`repo.saveBrief`), so a failed run is retried next time.

`runInternalSummarize` takes the lease `summarize:<root>` (120 s) with a holder unique to the run. If another run holds the lease, it returns at once. Otherwise it:
1. ingests every project (20 s budget; errors logged);
2. polishes only when `polish.provider` is not `off`;
3. releases the lease.

**Recursion guard (R-C7).** CLI providers run with the prompt on stdin, cwd `~/.leftoff/tmp`, and env `LEFTOFF_INTERNAL=1`:
- Claude writes no session and has no tools.
- Codex is ephemeral and read-only.

The hooks honouring `LEFTOFF_INTERNAL` arrive in Task 13. Collectors already ignore projects inside `LEFTOFF_HOME`.

## 5. Design decisions

1. **Codex reply from `-o <file>`.** `codex exec --help` (0.163.0) documents `-o, --output-last-message <FILE>`; it does not say what goes to stdout. Reading the file avoids guessing which stdout lines are the reply. The plan's required flags are all kept.
2. **Lock holder `pid:uuid`, not the bare pid.** With the pid alone, two summarizes in one process both "renew" the same lock. The concurrency test caught this (mutation M3).
3. **Only successful polish is saved.** Saving a failed (null) result under the current hash would block retries until the facts change.
4. **No polish for an empty project.** It would cost a call to say "nothing happened".
5. **Background summarize ingests all projects.** It runs after SessionEnd with a 20 s budget, so it keeps the other projects fresh too. The plan doesn't say whether to filter.
6. **Masked test failures need a trimming pipe.** Without that, `cat old-run.log` showing "1 failed" would count as a failing test. Your required case (`npm test 2>&1 | tail -20`) is detected.
7. **`anthropic` uses `fetch`, as the plan says.** It does not use the SDK, so there is no new dependency.
   - It sends `anthropic-version: 2026-10-21` (current per the bundled API reference) and no sampling fields (they are rejected on that version).
   - `max_tokens` is 4000, which leaves room for the model's thinking.
   - It reads only the `text` blocks.
8. **`spawnBackgroundSummarize(root, cliPath = process.argv[1])`.** In the built CLI that is `dist/cli.js`. Tests pass a recording script, so a real detached child is checked rather than a spy.
9. **`resume --polish` with polish off** prints one line to stderr (your decision, Part C): ``Polish is off. Turn it on with `leftoff setup` or `leftoff config set polish.provider <claude-cli|ollama|…>`.`` The brief is still shown on stdout.
10. **Ollama and thinking models (Part C).** The request sends `think: false`. Ollama 0.40.8 is installed, the parameter exists since 0.9, and `/api/show` lists `thinking` among qwen3:4b's capabilities. As a fallback, any closed `<think>…</think>` block is removed from the reply before validation.

## 6. Tests

### 6.1 Real-fixture briefs, re-rendered

Same method as before:
- the built CLI;
- temp copies of `tests/fixtures/{claude,codex}/session-basic.jsonl`;
- live git state from the untouched scratch folders;
- `NO_COLOR=1`, about 19 hours after the sessions.

**Claude Code session.** Before (Task 11), the npx line was cut before its suffix, and both commands carried `2>&1`:

```
  ✗ `npx --no-install eslint . 2>&1` — npm error npx canceled due to missing packages and no YES op…
  ✗ `npm run lint 2>&1` — npm error Missing script: "lint" (still failing)
  → Verify: `npx --no-install eslint . 2>&1` still failing
```

After:

```
$ leftoff resume --project /private/tmp/leftoff-fixture
Where you left off — leftoff-fixture (main) · last active 19h ago

Agent said done, but
  claude said: "All tests pass, done." (19h ago)
  ✗ `npx --no-install eslint .` — npm error npx canceled due to missing packages an… (still failing)
  ✗ `npm run lint` — npm error Missing script: "lint" (still failing)

Done
  • Edited 1 file: calc.js

Unfinished
  • calc.js (untracked)
  • calc.test.js (untracked)
  • package.json (untracked)

Next step
  → Verify: `npx --no-install eslint .` still failing

Sources: claude ✓  git ✓  shell ✓  codex ✓
```

**Codex session** (unchanged: Codex runs without `2>&1`):

```
$ leftoff resume --project /private/tmp/leftoff-codex-fixture
Where you left off — leftoff-codex-fixture (main) · last active 19h ago

Agent said done, but
  codex said: "All tests pass, done." (19h ago)
  ✗ `npx --no-install eslint .` — exit code 130 (still failing)
  ✗ `npm run lint` — npm error Missing script: "lint" (still failing)

Done
  • Edited 1 file: calc.js

Unfinished
  • calc.js (untracked)
  • calc.test.js (untracked)
  • package.json (untracked)

Next step
  → Verify: `npx --no-install eslint .` still failing

Sources: claude ✓  git ✓  shell ✓  codex ✓
```

**Loose ends and standup on the same data:**

```
$ leftoff loops
Loose ends across 2 projects

leftoff-fixture (main) · 19h ago
  ! Agent said "All tests pass, done." — 2 problems still failing
  ✗ `npx --no-install eslint .` — npm error npx canceled due to missing packages and no YES option:…
  ✗ `npm run lint` — npm error Missing script: "lint"
  • 3 uncommitted files
leftoff-codex-fixture (main) · 19h ago
  ! Agent said "All tests pass, done." — 2 problems still failing
  ✗ `npx --no-install eslint .` — exit code 130
  ✗ `npm run lint` — npm error Missing script: "lint"
  • 3 uncommitted files

Run `leftoff resume` inside a project for details

$ leftoff standup --all --since 2026-10-25
Yesterday:
- leftoff-codex-fixture: Worked on calc.js with codex
- leftoff-fixture: Worked on calc.js with claude
Today:
- leftoff-codex-fixture: Verify: `npx --no-install eslint .` still failing
- leftoff-fixture: Verify: `npx --no-install eslint .` still failing
Blockers:
- leftoff-codex-fixture: `npx --no-install eslint .` — exit code 130
- leftoff-codex-fixture: `npm run lint` — npm error Missing script: "lint"
- leftoff-fixture: `npx --no-install eslint .` — npm error npx canceled due to missing packages and no YES option: ["eslint@10.13.0"]
- leftoff-fixture: `npm run lint` — npm error Missing script: "lint"
```

### 6.2 Real AI calls

**`claude -p` (one call, approved by you).** The command shown before the run, run exactly once:

```
$ LEFTOFF_HOME=…/scratchpad/real12/lhome NO_COLOR=1 node dist/cli.js resume --project /private/tmp/leftoff-fixture --polish
Where you left off — leftoff-fixture (main) · last active 19h ago

On `main` in leftoff-fixture, you last edited `calc.js`, and `calc.js`, `calc.test.js`, and `package.json` are all still untracked. The session ended with the claim "All tests pass, done.", but two lint problems were still failing at that point. `npm run lint` fails with a missing "lint" script, and `npx --no-install eslint .` was canceled because `eslint@10.13.0` isn't installed. Next step: check whether `npx --no-install eslint .` is still failing.

Agent said done, but
  claude said: "All tests pass, done." (19h ago)
  ✗ `npx --no-install eslint .` — npm error npx canceled due to missing packages an… (still failing)
  ✗ `npm run lint` — npm error Missing script: "lint" (still failing)
…
Sources: claude –  git ✓  shell –  codex –
exit=0
elapsed 12.8s
```

- **Time:** 12.8 s from start to finish, including the leftoff work.
- **Validation:** passed. The reply is 4 sentences and 454 characters, well under 1200.
- **Accuracy:** the paragraph adds nothing that isn't in the facts; every claim matches the brief below it.
- **Sources line:** `claude –` and the other dashes are expected. The scratch config switched those collectors off, so this run never read your real logs.

**Check of `~/.claude/projects`** (listing before vs after):
- One new folder appeared: `-private-tmp-claude-501-…-scratchpad-real12-lhome-tmp`, which is the polish cwd.
- It contains only an **empty `memory/` folder**. There is **no session transcript** (`.jsonl`), so `--no-session-persistence` held.
- Claude Code creates that per-project memory folder for any cwd it starts in. It is empty and harmless:
  - leftoff's Claude collector reads only `*.jsonl` files;
  - projects inside `LEFTOFF_HOME` are ignored anyway.
- In real use the cwd is always `~/.leftoff/tmp`, so this happens once, as a single folder.
- I left it in place because it's in your home directory. To remove it: `rmdir ~/.claude/projects/-private-tmp-claude-501--Users-apple--claude-spares-spare-qPCfF3-7dd00b1d-288b-4571-ae53-8054090ee23c-scratchpad-real12-lhome-tmp/memory ~/.claude/projects/-private-tmp-claude-501--Users-apple--claude-spares-spare-qPCfF3-7dd00b1d-288b-4571-ae53-8054090ee23c-scratchpad-real12-lhome-tmp`.

**Ollama (one call, approved by you; you started `ollama serve`).**
- Version 0.40.8. `ollama list` shows only `qwen3:4b` (2.5 GB, ID 359d7dd4bcda). Nothing was pulled.
- **Setup:** a fresh scratch home (`real12/lhome-ollama`). A fresh one was needed because the saved Claude summary for the same facts would otherwise be reused.
  - Step A (no AI) ingested the fixture.
  - The config then switched the collectors off and set `polish.provider` to `ollama` with `ollamaModel` `qwen3:4b`.
  - `LEFTOFF_INTERNAL=1` doesn't apply here: Ollama is an HTTP call, not a subprocess.
- **Result: timed out.** It took 60.4 s, and the log has `[polish] ollama: The operation was aborted due to timeout`.
  - The brief was shown with facts only, and the command exited 0 as designed.
  - Nothing was saved, so a later run will try again.
- Afterwards, `ollama ps` showed `qwen3:4b` loaded (3.2 GB, 100% GPU, context 4096) on this 8 GB MacBook Air (M1).
  - So most of the 60 s was likely the cold model load plus generation.
  - I didn't retry, since you allowed one call.
- This is the "very slow" case you asked me to report. Whether a warm model fits under 60 s here is untested.

**codex-cli, anthropic, openai:** not run for real, as you asked. They are covered by fake CLIs and local HTTP servers.

**Flags re-checked** with `--help` (no AI calls), Claude Code 2.1.311 and codex-cli 0.163.0:
- `-p`, `--no-session-persistence` ("sessions will not be saved to disk"), `--tools` (`""` disables all tools), `--output-format`;
- `exec --ephemeral`, `--skip-git-repo-check`, `-s/--sandbox`, `-o/--output-last-message`, and `-` (prompt from stdin).

### 6.3 RED

Each new test failed for the expected reason before the code existed:
- **Suffix:** `expected '  ✗ `npm run lint` — npm error xxxx…' to match /… \(still failing\)$/`.
- **Normalization:** 17 `normalizeCommand` cases failed. Also failing:
  - `an agent failure with 2>&1 is resolved by the same command succeeding in your shell`;
  - `a leading cd <dir> && is ignored when matching, and the command is shown without it`;
  - `a failing test run piped through | tail (exit 0 from tail) is still test_failed` (Claude and Codex).
- **Polish:** the four `tests/polish` files failed with `Cannot find module '../../src/polish/…'`.
  - The `--polish` test got `'Done'` where the paragraph should be.
  - The `internal summarize` CLI test exited 1 (unknown command).

**Part C:**
- **Hint:** `expected undefined to be 'Polish is off. Turn it on with `lefto…'`.
- **Ollama:** both tests failed:
  - the request body had no `think: false`;
  - the `<think>` block was still in the reply.

  Undoing either change in the code makes its test fail again.

### 6.4 Mutation checks (code broken on purpose, then restored)

**Part A** (one at a time, each restored from a backup and compared byte for byte):

| # | Mutation | Caught |
|---|---|---|
| 1 | exit 0 trusted even without a trimming pipe | yes (1) |
| 2 | quotes ignored by the tokenizer | yes (3) |
| 3 | `tail` not a trimming pipe | yes (5) |
| 4 | `cat` / `less` stripped with arguments | first survived → added `npm test \| cat -A` → yes |
| 5 | `2>&1` swallows the next word | first survived → added `make 2>&1 build` → yes |
| 6 | `cd` guard `and <= 2` removed | survived; the guard was dead code and is removed |
| 6b | `cd x;` treated like `cd x &&` | yes (added `cd /x; npm test`) |
| 7 | brief contradiction not kept-tail | yes (1) |

**Part B:**

| # | Mutation | Caught |
|---|---|---|
| M1 | CLI env without `LEFTOFF_INTERNAL` | yes |
| M2 | `--bare` added to the claude args | yes |
| M3 | lock holder = bare pid | yes |
| M4 | polish runs when `provider` is `off` | first survived (test project had no activity, so polish returned early) → test seeds activity → yes |
| M5 | cache check skipped | yes |
| M6 | cached entry without text counts as cached | first survived → new test → yes |
| M7 | `auto` ignores `polish.enabled` | yes |
| M8 | no timeout race | yes |
| M9 | `resume --polish` ignored | yes |
| M10 | background spawn without `LEFTOFF_INTERNAL` | yes |
| M11 | prompt always the smallest version | yes |
| M12 | empty project still polished | yes |
| M13 | codex without `-s read-only` | yes |
| M14 | codex without `--ephemeral` | yes |
| M15 | lock never released | yes |
| M16 | timed-out CLI not killed | first survived → test checks the process left no marker → yes |
| M17 | spawn cwd not `~/.leftoff/tmp` | yes |

Two mutation runs went wrong:
- My first Part A run used a backup path that was an existing file.
- My first Part B run used a zsh variable that didn't split into separate file names.

In both, the backups failed and the mutations piled up in the source. I reverted each mutation by hand, checked with `grep` and a green `npm run check`, then reran every mutation from a `bash` script with per-file backups and a byte-compare after each restore. Only the reruns' results are listed above.

### 6.5 Tests

`npm run check` (tsc, eslint, prettier, vitest): **40 files, 592 passed, 1 skipped** (the fish raw-tab test, by design). That is 537 before, plus 25 for Part A, plus 30 for Task 12 and Part C:
- prompt 3
- chain 6
- providers 10 (C: `<think>` stripping; the Ollama body test also checks `think: false`)
- summarize 8
- resume 2 (C: the polish-off hint, through `runResume` and through the real CLI's stderr)
- internal 1

The plan's ten named tests are all present:

| Plan test | Where |
|---|---|
| off → no providers | chain |
| auto tries next provider when first throws or times out | chain |
| invalid polish output is discarded | chain |
| cached polish reused when factsHash unchanged; no provider call | summarize |
| two concurrent summarizes: only one calls the provider | summarize |
| claude-cli spawns with LEFTOFF_INTERNAL=1 and cwd in LEFTOFF_HOME/tmp | providers (a fake `claude` records env, cwd and stdin) |
| claude-cli args include --no-session-persistence and --tools "" and never --bare | providers |
| codex-cli args include --ephemeral, --skip-git-repo-check and -s read-only | providers |
| internal summarize with polish off still ingests and calls no provider | summarize |
| prompt contains facts JSON and the no-invention instruction, ≤ 8000 chars | prompt |

## 7. Edge cases and failure handling

- **Provider failures:** a provider that is missing, throws, hangs, exits non-zero, answers with an HTTP error, or returns empty or overlong text is skipped and logged. The next provider is tried, and the brief still shows the facts.
- **Timeouts:**
  - A CLI past its timeout is killed with SIGKILL; the test checks it left no trace.
  - HTTP providers use `AbortSignal.timeout`.
  - The chain races each call against the same timeout.
- **Quoted text:** a `>` or `|` inside quotes is not a redirection or pipe.
- **Lone commands:** a bare `cd /x` or `FOO=1` is left as it is.
- **Background errors:** `internal summarize` prints nothing and exits 0. Errors go to the log.
- **Spawn failures:** `spawnBackgroundSummarize` never throws. A spawn error is logged.
- **Overlong facts:** facts larger than 8000 characters are shrunk in steps:
  1. drop `sources`;
  2. lists to 10, 5, 3, then 1 item;
  3. texts to 300, then 100 characters.

  The JSON stays valid and the next step is kept.

## 8. Deviations from the plan

- **codex:** adds `-o <file>` (§5.1).
- **Lock holder:** `pid:uuid` instead of the pid (§5.2).
- **`polishNow`:** saves only successes and skips empty projects (§5.3, §5.4).
- **`runInternalSummarize`:** takes an optional `deps.providers` (test seam). It ingests all projects (§5.5).
- **`spawnBackgroundSummarize`:** has a `cliPath` parameter (§5.8).
- **Extra files:** `src/polish/providers/run-cli.ts` and `http.ts` (shared helpers), not in the plan's file list.
- **Part C:** `runResume` returns `{ output, exitCode, stderr? }`, a new optional field, so the CLI writes the hint to stderr.
- **Part A:** the masked test-failure rule needs a trimming pipe (§5.6). It is added to §1.7.

## 9. Open questions and risks

1. **Ollama is slow on this machine.** The cold call timed out at 60 s (§6.2). Options:
   - (a) keep 60 s; the background summarize retries next time, when the model may still be warm;
   - (b) a longer timeout for `ollama` only;
   - (c) recommend a smaller model in `setup`.

   This affects only background polish and `--polish`. Your call; I lean (a) for now and revisit after dogfooding (Task 17).
2. **The empty `~/.claude/projects/<cwd>/memory` folder** that `claude -p` creates (§6.2). It holds no transcript. Fine to leave as is, unless you'd rather polish ran with a cwd you don't mind seeing there.
3. **Anthropic API version.** The provider pins `anthropic-version: 2026-10-21`. When Anthropic ships a newer version, this line changes.
4. **The Task 10 §9.3 probe-count `doctor` line** is still open (Task 15).

## 10. Commit

`0eb7093` — `feat(polish): optional llm polish with background summarize` (filled in by Task 13's commit, B11).
