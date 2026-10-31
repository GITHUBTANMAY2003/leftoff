# Task 16: End-to-end and performance tests

This commit has three parts:

- **A.** Your answers after 15b: the re-read of your Claude transcripts, three brief changes, and the Task 17 exit criterion.
- **B.** Task 16 itself: the end-to-end scenario, the performance budgets, and real hook latency (Step 2b).
- **C.** The cheap `cd` (Step 2a): **about 115 ms → under 4 ms** in zsh, bash 3.2 and fish.

The goldens use the narrative format. Not pushed.

## 1. Part A: your answers after 15b

### 1.1 The one-time re-read of your Claude transcripts (answer 1, done on your real DB)

1. I backed up the DB first to `~/.leftoff/leftoff-before-claude-reread.db` (mode 600). You can delete it once you're happy.
2. I rebuilt `dist/`, deleted every `claude` event and the Claude read positions, then ran `leftoff internal ingest` until nothing new arrived.

| Claude events | Before | After |
|---|---|---|
| `user_prompt` | 109 | 73 (subagent prompts gone) |
| `agent_message` | 700 | 657 (subagent replies gone); 72 with their opening kept |
| `command` / `command_failed` / `test_failed` | 1863 / 32 / 120 | 1865 / 32 / 123 |
| `file_edit` / `tool_error` | 265 / 5 | 265 / 5 |
| `session_start` / `session_end` / `checkpoint` | 3 / 5 / 6 | 3 / 5 / 6 (restored, see below) |

**One slip, already repaired.** The plugin's hook events (session start/end, checkpoints) have source `claude` too, but they come from hooks, not transcripts, so the re-read couldn't bring them back. I copied those 14 rows back from the backup, matched by their dedupe keys.

**Your real `~/leftoff` brief afterwards** (`leftoff resume`, run during this session, so it describes this session):
```
leftoff · just now · branch main
  You asked: 15b approved.
  Claude's last update: Hook events are back. Here is your real `~/leftoff` brief now, followed by…
  Still open: 6 uncommitted files
  Pick up with: Review and commit 6 uncommitted files (src/brief/loose-ends.ts…
```
In loose ends, LoopLint now reads "7d ago" (your last work there) instead of "2d ago".

### 1.2 The brief changes (answers 2, 3, 5), test-first

- **Loose ends show when you last worked on a project** (`LooseEnds.lastActiveAt` is the end of the last work session). "Stale" and the ordering use the same time.
- **The auto brief shows at most two sentences of the polished summary, about 200 characters.** If the first sentence alone is longer, it is cut at a word. `resume` shows it whole.
- **"You asked" is the first sentence of your request, about 100 characters,** cut at a word. Leading `@file` mentions are skipped, so `@docs/plan.md @docs/PROGRESS.md We're continuing…` reads `We're continuing…`.
- Answer 4 (offers count as questions) needed no change. It is now written into the plan.

### 1.3 Plan text

Task 17's exit criteria now include the brief rating: after a break of at least a day, each beta tester answers "Did it correctly tell you where you left off and what to do next?" Release only if at least 4 of 5 briefs get "yes". §1.8 records your answers 2–5.

## 2. Files

**Created**
- `tests/e2e/helpers.ts`: the scenario builder, `run`, `stats`, `measureCd`, and a cleanup that waits for background jobs.
- `tests/e2e/rahul.e2e.test.ts` (6 tests) and `tests/e2e/perf.e2e.test.ts` (9 tests).

**Modified**
- `shell/leftoff.{zsh,bash,fish}`: the pure-shell project root and the marker check.
- `src/cli/commands/brief-auto.ts`: the "quiet until" marker.
- `src/render/narrative.ts`, `src/render/auto.ts`, `src/brief/loose-ends.ts`: the fold-ins.
- `vitest.config.ts`: e2e files run one at a time, with a 120 s timeout.
- `.gitignore`: `.e2e-tmp/`.
- Tests: `tests/cli/brief-auto.test.ts`, `tests/shell/auto.test.ts`, `tests/render/{narrative,auto}.test.ts`, `tests/brief/loose-ends.test.ts`.
- Docs: the plan (§1.8, Task 16 "as built", Task 17 exit criteria) and `docs/PROGRESS.md`.

## 3. Part B: end to end

**The scenario.** `rahulScenario()` writes §1.1 the way the real tools write it, 14 hours before the test:
- a git repo on `feature/forgot-password` with two dated commits and `email_service.py` changed;
- a Claude Code transcript in the real record format: the request, three `SMTP connection refused` runs, the two `sed` fixes, and the last message;
- two shell-log lines;
- a planted secret (`DB_PASSWORD=hunter2` in the shell, `Bearer hunter2…` in an agent command).

The built CLI runs with `HOME`, `LEFTOFF_HOME`, `CLAUDE_CONFIG_DIR` and `CODEX_HOME` pointed into the scenario.

**Where the scenario lives.** It is in the repo's git-ignored `.e2e-tmp/`, not the system temp folder, because loose ends now leave out temp folders. The cleanup waits for detached background jobs (they hold a row in `locks`) before deleting. Without that, `session-end`'s background summarize recreated the folder after the test (seen and fixed).

| Test | Checks |
|---|---|
| `resume` | output is byte for byte `tests/render/golden/rahul-brief.txt`, the same narrative golden the renderer test uses |
| `hook claude-session-start` | exact first and last lines; "You asked", "It stopped with", and `Already tried (did not fix it): sed … ; sed …` |
| `standup --since 24h` | the Task 11 text (Yesterday: the two commits; Today and Blockers: the SMTP problem) |
| bare `leftoff` | exactly: `myapp (feature/forgot-password) · 14h ago`, the problem with `(3 attempts)`, `• 1 uncommitted file` |
| no `~/.codex` | `--details` shows `Sources: claude ✓  git ✓  shell ✓  codex –` |
| secrets | `hunter2` is in neither `leftoff.db` nor `leftoff.db-wal`, nor in `resume --json` |

## 4. Performance

The e2e project runs one file at a time, so these are measured with no other tests running. Every perf test prints its numbers. Machine: your M-series Mac, built CLI.

| Budget | Result |
|---|---|
| `resume` p95 < 300 ms, no new data, 20 runs | median 213 ms, **p95 217 ms** |
| ingest of a 50 MB new transcript < 1500 ms | 49 MB in **1162 ms**; the test also checks every record was read (≈ 26,000 commands) |
| zsh hook overhead < 5 ms per command, 200 runs | **median 0.1 ms**, p95 0.1 ms |

### Step 2b: real hook latency

Hooks run through the shim with JSON on stdin, the way Claude Code runs them, one at a time, 20 runs each.

| Hook (budget) | Scenario: median / p95 | Copy of your real DB, `~/leftoff`: median / p95 | Same, LoopLint: median / p95 |
|---|---|---|---|
| `claude-session-start` (2 s) | 218 / 225 ms | 151 / 159 ms | 261 / 268 ms |
| `claude-stop` (500 ms) | 104 / 108 ms | 103 / 108 ms | 104 / 106 ms |
| `claude-session-end` (500 ms) | 111 / 122 ms | 107 / 111 ms | 107 / 110 ms |

The real-data rows used a backup copy of your DB, with collectors and polish off in the copy. That way no 60 test sessions landed in your real DB. All are well within budget, and the scenario rows are asserted in `perf.e2e.test.ts`.

## 5. Part C: `cd` costs almost nothing when no brief is due (Step 2a)

**Why it is built differently from the plan.** The plan described a "due" marker. Whether a brief is due depends on *time passing* (4 h after your last activity), and nothing runs at that moment to create the marker. So it is built as a **"quiet until" marker** instead.

**Node side.** `brief --auto` writes `~/.leftoff/shell/quiet/<project path with % → %25, / → %2F>`. The file holds the epoch second before which no brief can be due:
- the last activity + gap, when that activity's brief hasn't been shown;
- otherwise (shown, no activity yet, printing off, or an ignored project) now + gap;
- a due brief that was too slow to print removes the marker, so the next prompt tries again.

**Shell side.** Each hook finds the project with no process:
- **zsh:** `${PWD:A}` and `${dir:h}`;
- **bash:** `pwd -P` in a subshell (a fork, no exec) and `${dir%/*}`;
- **fish:** `builtin realpath` and `string replace`.

It walks up to the nearest `.git` and reads the marker with `read`. While the marker's time is in the future, node isn't started.
- zsh uses `$EPOCHSECONDS`.
- bash uses `$EPOCHSECONDS` on bash 5, else `date +%s`.
- fish uses `date +%s`.

**`cd` into another project, no brief due, 20 runs.** Each `cd` is timed from node as the shell prints a tick.

| Shell | Before (scripts from `3bac5b5`): median / p95 | After: median / p95 |
|---|---|---|
| zsh | 116.5 / 119.2 ms | **0.1 / 0.1 ms** |
| bash 3.2 (`/bin/bash`) | 114.8 / 117.1 ms | **2.9 / 3.3 ms** |
| fish 4.9 | 113.5 / 117.8 ms | **1.8 / 2.3 ms** |

These are asserted in `perf.e2e.test.ts` (median < 20 ms per shell). A project whose marker time has passed still calls `brief --auto` and prints its brief once (shell test in all three shells, plus the existing e2e).

**The trade-off.** After a brief is shown, the next one is checked a gap later. Activity that happened before that point but hadn't been read yet could have made a brief due earlier. The delay is at most the time since the last ingest. See §9.2.

## 6. Tests

**RED first:**
- the fold-ins: 4 failing tests;
- the marker: 4 node tests failed with `quietMarkerName is not a function`, plus the ignored-project test;
- the shell marker test failed in all three shells.

**Debugging along the way.**
- My first `cd` measurement showed ~100 ms in every shell. The cause was my test setup, not the code: I had made the projects with an empty `.git` folder. `git rev-parse` then walked up to the enclosing leftoff repo, so the marker was written for the wrong path. The test now uses `git init`.
- One e2e expectation was mine and wrong (5 attempts instead of 3: two `sed` fixes and the `curl`).

**Mutation pass.** I ran 8 mutations: the marker check in each of the three shells, the "last activity + gap" rule, the slow-brief marker removal, the first-sentence rule, the polish shortening and the loose-ends time. All 8 were caught, and the sources were restored after each.

**Results**
- `npm run check`: tsc, eslint and prettier clean; 949 passed, 1 skipped (the platform skip from earlier tasks).
- `npm run test:e2e`: 18 passed (4 files), and `.e2e-tmp/` is empty afterwards.

## 7. Edge cases

- **A project path too long for a file name** (over 255 bytes encoded): no marker is written (the error is logged), so the shell keeps calling node, which is correct, just not cheaper.
- **A project whose git top level isn't the nearest `.git`** (for example, a broken `.git` folder): the shell and node disagree on the root, so the marker isn't found and node runs, as before. Correct, just not faster.
- **`LEFTOFF_QUIET` / `autoBrief.enabled = false`:** the marker is now + gap, so the background ingest still runs about once per gap per project.
- **Your installed shell scripts** (`~/.leftoff/shell/`) are still the old copies. Until they are refreshed, every `cd` runs node as before. The new `dist/` already writes markers, which is harmless.

## 9. Questions for you

1. **Ctrl-C in your own terminal.** Your real loose ends now show `MyVoice-Enhanced · 22h ago`, with `` `for f in *.m4a; do … afplay "$f"; done` — exit code 130 ``. 130 means you pressed Ctrl-C. Should exit 130 from your own shell be ignored? I'd say yes: you stopped it yourself.
2. **The marker trade-off (§5):** after a brief is shown, the next one can come up to "time since last ingest" later than it strictly could. OK, or should the background ingest also refresh markers?
3. **Refresh your installed shell scripts** so the cheap `cd` is active: run `leftoff setup` (it rewrites the scripts and shim, asks before touching rc files), or I copy just the three scripts. Which, and may I?
4. **The backup** `~/.leftoff/leftoff-before-claude-reread.db` (5 MB): delete it now, or keep it until Task 17?
