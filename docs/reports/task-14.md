# Task 14: Auto brief on terminal open

This commit has three parts:

- **A.** Your three answers to Task 13 §9: questions and offers are never done-claims, chains of look-around steps are scratch, and the shim uses a stable node path and exits silently when broken. Your real shim was rewritten (allowed).
- **B.** Task 14 itself: `leftoff brief --auto`, the short brief renderer, the rate-limited background ingest (`leftoff internal ingest`), and `__leftoff_auto` in the zsh, bash and fish scripts.
- **C.** One bug found on real data while measuring: events over 4 KB lost their `command`, so such a failure could never be classified or resolved (Task 13 §9.2, third item).

The real-terminal try is in §6.3: the rc block was shown to you first, then added to your `~/.zshrc` together with the copied `leftoff.zsh` (you approved both).

## 1. Goal

When you open a terminal, or `cd` into another project, and that project's last activity is at least 4 hours old and you haven't seen a brief since, print a short "where you left off" (≤ 8 lines). It must never slow the prompt down noticeably, never print errors, and never wait for ingest. A detached background ingest runs at most every 10 minutes, so terminal-only users get fresh data and `shell.log` doesn't pile up (R-D3).

## 2. Files

**Created**
- `src/render/auto.ts`: `renderAutoBrief`.
- `src/cli/commands/brief-auto.ts`: `isBriefDue`, `runBriefAuto`.
- `src/ingest/background.ts`: `maybeSpawnBackgroundIngest`, `spawnBackgroundIngest`, `runInternalIngest`.
- Tests:
  - `tests/render/auto.test.ts` and the golden `tests/render/golden/rahul-auto.txt`;
  - `tests/cli/brief-auto.test.ts`, `tests/ingest/background.test.ts`;
  - `tests/shell/auto.test.ts` (zsh, bash 3.2, fish);
  - `tests/e2e/brief-auto.e2e.test.ts` (built CLI).

**Modified**
- `shell/leftoff.zsh`, `shell/leftoff.bash`, `shell/leftoff.fish`: `__leftoff_auto`.
- `src/cli/index.ts`: hidden `brief --auto` and `internal ingest`.
- `src/cli/commands/internal.ts`: `runInternalIngestCommand`.
- Part A:
  - `src/brief/facts.ts`: sentence-level claims;
  - `src/collectors/scratch.ts`: the chain rule;
  - `src/model/event.ts`: `chainSteps`, plus the Part C `shrink` fix;
  - `src/install/shim.ts`: `stableNodePath` and the guard line.
- `vitest.config.ts`: unit `testTimeout` 20 s (§5.6).
- Tests: `tests/brief/facts.test.ts`, `tests/collectors/scratch.test.ts`, `tests/install/shim.test.ts`, `tests/model/event.test.ts`, `tests/cli/internal.test.ts`, `tests/shell/hooks.test.ts` (re-sourcing now shows the auto hook too).
- Docs: plan §1.7 (claims, scratch chains), §1.8 (auto brief as built), Task 13 interfaces (shim), Task 14 shell wiring, Task 15 setup and doctor.

## 3. Interfaces produced

- `isBriefDue(root, repo, config, now): boolean`. True when all of these hold:
  - `autoBrief.enabled` is on and `LEFTOFF_QUIET` is empty;
  - the last activity is at least `gapHours` old;
  - no brief has been shown since that activity.
- `renderAutoBrief(f: BriefFacts, opts: { color: boolean; now?: Date }): string`.
- `runBriefAuto(cwd, deps?: { now?, readWorking?, spawnIngest? }): Promise<string>`.
- `maybeSpawnBackgroundIngest(repo, now, spawnIngest = spawnBackgroundIngest): boolean`.
- `spawnBackgroundIngest(cliPath = process.argv[1]): void`.
- `runInternalIngest(deps?: { ingest? }): Promise<void>`.
- `chainSteps(cmd): string[]`: the steps of a `&&`/`;` chain, split outside quotes.
- `stableNodePath(execPath = process.execPath, pathEnv = process.env.PATH): string`.

## 4. How it works

**`leftoff brief --auto`** (300 ms budget, measured from the start of the run):
1. Stops at once if `LEFTOFF_INTERNAL=1` or `LEFTOFF_QUIET` is set.
2. Stops if the project is inside `LEFTOFF_HOME`, ignored, or auto brief is disabled.
3. Opens the DB and calls `maybeSpawnBackgroundIngest`. If cursor `('ingest','last_bg')` is missing or at least 10 minutes old, it writes `now` there and spawns `leftoff internal ingest`: detached, `stdio: 'ignore'`, `LEFTOFF_INTERNAL=1`, cwd `~/.leftoff/tmp`, `unref()`.
4. If the brief is not due → `''`.
5. Otherwise it reads the live git state (the only foreground read), builds the facts from stored events (`report: null`, so the Sources line isn't used) and renders.
6. If more than 300 ms have passed → `''`, and the brief stays due for the next prompt. Otherwise it marks the brief shown for the current last activity and returns the text.

The CLI writes the text and exits right away (`process.exit(0)` in the write callback), so the detached child never holds the prompt.

**Auto brief layout** (golden `rahul-auto.txt`):
```
Where you left off — myapp (feature/forgot-password) · last active 14h ago
  • 1 uncommitted file
  ✗ `python scripts/send_test_email.py` — SMTP connection refused
Run `leftoff resume` for details
```
- At most one problem is shown, with `(+N more)`: the one the next step verifies, else the first.
- `→ <next step>` is left out when it would only repeat that problem.
- Lines are cut to 100 characters. Only the first line is bold, and only on a TTY without `NO_COLOR`.

**`leftoff internal ingest`:**
- takes lock `ingest:bg` (holder `pid:uuid`, TTL 120 s);
- ingests all projects with a 20 s budget;
- releases the lock;
- errors go to the log.

**Shell side** (all three shells): a prompt hook.
- zsh: `precmd`, added after the logging hook.
- bash: `__leftoff_auto` right after `__leftoff_prompt` in `PROMPT_COMMAND`. It keeps `$?` for whatever else is in `PROMPT_COMMAND`.
- fish: the `fish_prompt` event.

On every prompt:
1. If `$PWD` didn't change, it returns at once (no process started).
2. If `$PWD` changed, it runs `git rev-parse --show-toplevel` (falling back to `$PWD`).
3. If that's a different project from last time, it runs the shim with `brief --auto`, falling back to `leftoff` on PATH, else nothing. Its stderr goes to `/dev/null`.
4. Nothing runs while `LEFTOFF_QUIET` is set or `LEFTOFF_INTERNAL=1`.

The state is kept across re-sourcing, so re-sourcing doesn't print again.

**Part A:**
- **Claims:** read per sentence. Lines are split, then split at `[.!?]` followed by a space. A sentence counts if it has a done-word, doesn't end in `?` (closing quotes and brackets allowed), and doesn't contain `or`, `should I`, `shall I` or `want me to`. The message-level negation check is unchanged. Only claim sentences decide whether a claim is a commit claim (R-D1).
- **Chains:** a chain of 2 or more `&&`/`;` steps, each a `cd`, a probe (`isProbeCommand`) or scratch (`isScratchCommand`), and not all `cd`, is scratch.
- **Shim:**
  - the first line is `[ -x '<node>' ] && [ -r '<cli>' ] || exit 0`;
  - the node path is `stableNodePath()`: the first `node` on PATH whose realpath equals `execPath`'s, skipping `fnm_multishells`, else `execPath`;
  - `shimStatus().works` is false when either path is gone, so doctor can say "shim broken, run leftoff setup" (Task 15).

## 5. Design decisions

1. **A prompt hook instead of `chpwd`.** bash has no `chpwd`, and one rule in all three shells is easier to test. The cost on an unchanged `$PWD` is a string compare.
2. **Quiet and disabled skip the background ingest too.** `LEFTOFF_QUIET` means leftoff stays out of your terminal, and `resume` still ingests in the foreground. (See §9.3.)
3. **The budget check happens before marking the brief shown,** so a slow run never "uses up" a brief you didn't see.
4. **The problem line follows the next step, and the next step isn't repeated:** on your Orbit10 and LoopLint data the first auto briefs showed `✗ <problem>` followed by `→ Verify: <the same command> still failing` (§6.2). The auto brief has room for one problem, so it shows the one the next step is about and drops the repeating line.
5. **The shim also checks the CLI file,** not only node. A deleted repo or `dist/` would otherwise print a node error in every hook.
6. **One unit `testTimeout` of 20 s.** With three more shells per run, the suite's process-spawning tests (standup clipboard, CLI providers, shim) went past vitest's 5 s default about 1 run in 4. I captured the "Test timed out in 5000ms" messages before changing it. Five full runs in a row passed afterwards.
7. **`shrink` keeps the command** (cut to 1000 characters) and drops other large fields first. Without the command, a failure is unclassifiable and can never be resolved.

## 6. Tests

### 6.1 RED

Each new test was run before the code and failed for the expected reason:
- **Claims:** `expected 'Is the parser fixed now?' to be null`.
- **Chains:** 3 of the new table rows failed. (`ls src; grep … | head` was already scratch, through its pipeline head.)
- **Shim:**
  - `stableNodePath is not a function` (×3);
  - the broken-node run returned `[126, '', …]` instead of `[0, '', '']`.
- **New modules:** `render/auto`, `background`, `brief-auto` all failed with "Cannot find module".
- **Shell tests:** each failed with `expected [] to deeply equal [ …(4) ]`.
- **Problem selection:** the "verified problem" render test failed before the change.
- **`shrink`:** the test failed on the old code (`command` was dropped).

### 6.2 Real data (read-only snapshot of `~/.leftoff/leftoff.db`)

**`brief --auto` latency.** Wall clock, through your real shim, so node startup is included. 20 runs each against a copy of the DB:

| Project | Brief due? | Median | p95 | Max |
|---|---|---|---|---|
| LoopLint | yes (3d ago) | 180 ms | 192 ms | 240 ms |
| Orbit10 | yes (4d ago) | 204 ms | 253 ms | 283 ms |
| LoopLint | no (already shown) | 97 ms | 100 ms | 182 ms |
| leftoff | no (active now) | 98 ms | 104 ms | 108 ms |

The first version printed `→ Verify: \`ollama serve\` still failing` (Orbit10) and `→ Verify: \`source "$HOME/.cargo/env" && cargo test …\` still failing` (LoopLint) right under the same problem. After the change (re-run, same timings: median 204 / 198 ms):
```
Where you left off — Orbit10 (main) · last active 4d ago
  • 23 uncommitted files
  ✗ `ollama serve` — exit code 137 (+17 more)
Run `leftoff resume` for details

Where you left off — LoopLint (feat/m0-m1) · last active 3d ago
  ✗ `source "$HOME/.cargo/env" && cargo test -p looplint_adapters | grep -E… (+5 more)
Run `leftoff resume` for details
```

**Fix 1 on every real agent message** (885 messages):
- The old rule found 124 claims and the new rule 120.
- The 4 dropped messages are all non-claims: a conditional ("If the template leaves … I'll keep … placeholders"), a "…completed, not that the sound was audible", an "After your session I'll do the checks…", and my own Task 13 question.
- No real claim was lost.

**Fixes 1 and 2 on open problems** (same clock as Task 13, today's data):
- 44 → 44: no project changed.
- The look-around chains still open in your data contain steps that are neither probes nor scratch by the current lists: `rg … && sed -n …`, `tail … && ls -ld … && lsof …`, `ls -la … && find … && node --version && pnpm --version`. By your rule they stay open (§9.1).

### 6.3 Real terminal (with your approval)

1. I showed the exact block, generated by the real `installShellHook` against a copy of `~/.zshrc`.
2. With your approval:
   - backed up `~/.zshrc` to the scratchpad;
   - copied the scripts with `installShellScripts` (`~/.leftoff/shell/leftoff.{zsh,bash,fish}`, mode 600, first line `# leftoff 0.0.1`; only the zsh one is sourced);
   - ran `installShellHook('zsh', ~/.zshrc, …)`.

   The result is byte-identical to what you were shown.
3. Smoke test: a real `zsh -i` under a pseudo-terminal, loading your `~/.zshrc`, in this repo (no brief due here). It typed `echo smoke-test-one` and `cd …/src`.
   - Nothing extra was printed: no brief and no error text.
   - The `last_bg` cursor was set on the first prompt.
   - The background ingest picked up `shell.log` and stored both commands as `shell` events under `/Users/apple/leftoff`, with the right `cwd`. The log file was consumed and removed.
   - `~/.leftoff/logs/leftoff.log` is unchanged (4 old lines, no new errors).

I did not trigger a real auto brief in your other projects: that would mark them shown before you see them.

### 6.4 Mutation checks

The checks ran from a bash script with per-file backups, byte-compared after each restore. 22 mutations were caught. One survived (`shown < last` removed in `isBriefDue`); I added a test (newer activity makes the brief due again), and it is now caught. The mutations covered:
- the claim filters (`?`, `or`, `shall I`, commit-claim sentences);
- the chain rule (all-`cd`, length, the scratch step, `;` splitting);
- the shim (fnm skip, CLI guard, stable path);
- the 10-minute limit and the lock;
- the budget check, quiet and the gap;
- the repeated next step;
- the zsh project compare, bash stderr discarding and fish quiet.

### 6.5 Results

- `npm run check`: tsc, eslint and prettier clean; 725 passed, 1 skipped (the platform skip from earlier tasks). Five consecutive full runs were green.
- `npm run test:e2e`: 3 passed.

## 7. Edge cases and failure handling

- **No activity,** inside `LEFTOFF_HOME`, an ignored project, `LEFTOFF_INTERNAL=1`, `LEFTOFF_QUIET`, or auto brief disabled → empty output, exit 0.
- **Slow git or DB** (over 300 ms) → empty output, and the brief stays due.
- **Any error** → logged, empty output, exit 0.
- **No shim and no `leftoff` on PATH** → the shell hook does nothing and prints nothing.
- **`brief --auto`'s stderr** is discarded by the shell hook. The tests check that a fake's stderr never shows.
- **A `cd` within the same git repo** does nothing. Entering another repo, or leaving it, runs `brief --auto` once.
- **Two background ingests at once** → the second returns immediately (lock).
- **Shim node or CLI removed** → the shim exits 0 silently.
- **Old events that already lost their command** (before the `shrink` fix) stay unclassifiable until they leave the window. One such event is in the leftoff brief now.

## 8. Deviations from the plan

- **`renderAutoBrief`:** takes `opts { color, now }` (the plan said `(f)`), like the other renderers.
- **Test seams:** `runBriefAuto` takes optional deps (`now`, `readWorking`, `spawnIngest`), and `maybeSpawnBackgroundIngest` takes an optional spawner.
- **`spawnBackgroundIngest`** is exported.
- **`brief`** is a hidden command with a required `--auto`.
- **Triggers:** a prompt hook on `$PWD` change instead of `chpwd` + first prompt (§5.1).
- **Quiet and disabled** also skip the background ingest (§5.2).
- **`stableNodePath`** skips fnm's per-shell links, and the shim also checks the CLI file. Both go beyond your literal rule (§9.4).
- **Part C (`shrink` keeps the command)** is a change to Task 3's rule.
- **`vitest.config.ts`:** unit `testTimeout` 20 s.

## 9. Open questions and risks

1. **Look-around chains that stay open.** Your rule needs every step to be a probe, scratch or `cd`. Steps like these are none of those today:
   - `sed -n '1,5p' file`
   - `lsof`, `ls -ld`
   - `node --version`, `command -v x`

   The real examples are in §6.2. Options:
   - add `sed -n`, `nl`, `wc` and `<program> --version` / `-v` steps as probes;
   - add those steps to the chain rule only;
   - leave them.

   Your call.
2. **`;` chains of real test runs** (`npm run check | grep …; npm run test:e2e | grep …`) only match themselves (Task 13 rule). After they fail once, only the identical chain clears them. Three such entries from this task's flaky-timeout runs are in the leftoff brief now.
3. **Quiet and disabled skip the background ingest.** Should `LEFTOFF_QUIET` only silence the brief and still ingest?
4. **fnm skip and the CLI guard** in the shim: please confirm (§5.5, §8).
5. **The cost of `cd` between projects.** A not-due `cd` into another project starts node (~100 ms through the shim). Within a project, or with an unchanged `$PWD`, it costs nothing.
6. **Long commands crowd out the error** on the auto brief's single problem line. LoopLint's line shows only the start of a long `source … && cargo test … | grep -E…` command. `leftoff resume` shows the full problem.

**To undo the real-terminal change:**
- Delete the blank line and the 3-line `# >>> leftoff >>>` … `# <<< leftoff <<<` block at the end of `~/.zshrc`, or restore the backup at `/private/tmp/claude-501/-Users-apple--claude-spares-spare-qPCfF3/7dd00b1d-288b-4571-ae53-8054090ee23c/scratchpad/zshrc.backup-before-task14` (the scratchpad may be cleared later, and the manual delete always works).
- Optionally `rm ~/.leftoff/shell/leftoff.zsh ~/.leftoff/shell/leftoff.bash ~/.leftoff/shell/leftoff.fish`. With the block gone, the scripts are inert anyway.
- Open terminals keep the hook until they are closed.
- To keep the hook but silence it for a while: `export LEFTOFF_QUIET=1`.

## 10. Commit

`48a70ae feat: automatic brief on terminal open` (hash filled in by Task 15's commit, B11).
