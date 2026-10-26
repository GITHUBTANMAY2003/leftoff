# Task 05: Git collector

This commit has four parts, in the order you asked:

- **A.** fish hook tests fixed: fish now runs under a pseudo-terminal, and the vacuous tests are fixed.
- **B.** `npm ci` and better-sqlite3: verified.
- **C.** Plan text for Task 4's §8.1–8.4, plus your §9.4 answer (shared ignore globs in Tasks 6/7).
- **D.** Task 5 itself.

The report template sections below cover all four. §6 starts with the fish test run you asked to see before committing.

## 1. Goal

**Task 5 (plan):**
- `gitCollector`: for each known project (from `repo.projects()` plus `ctx.projectFilter`) that is a git repo, emit
  - `commit` events for commits after the cursor (the first run takes the last 7 days);
  - `branch_switch` events from `git reflog` entries `checkout: moving from X to Y` after the cursor.
- `readWorkingState(root)`: the live `{ branch, files, diffStat }` used by facts (Task 9). Detached HEAD → `detached@<short-sha>`; a repo with no commits still reports its branch and files.
- Every git call uses `execFile` with `timeout: 1000` and `maxBuffer: 1_000_000`. A failure becomes a collector warning, never a throw.

**Part A (your request):**
1. Run fish through a pty with `script`, detecting the util-linux or macOS form, and skip with a stated reason if neither works.
2. The two vacuous fish tests must prove, in the same run, that the hook records once the condition is removed.
3. Show passing fish tests from a real run.

## 2. Files

| File | Purpose |
|---|---|
| `src/collectors/git.ts` | **New:** `gitCollector`, `readWorkingState`, `WorkingState` |
| `tests/collectors/git.test.ts` | **New:** 17 tests on real temp repos |
| `tests/helpers/git.ts` | **New:** `git()`, `initRepo()`, `commit()` for tests, isolated from your git config |
| `src/model/redact.ts` | **Fix:** a `-name` inside a word is no longer treated as a flag (bug found by the git tests; see §4) |
| `tests/model/redact.test.ts` | 7 regression tests for that fix |
| `tests/shell/run-shell.ts` | **Part A:** fish runs under `script` (pty); `runInteractive` is now async; `cannotRun()` gives skip reasons |
| `tests/shell/hooks.test.ts` | **Part A:** the two vacuous tests now prove the hook is active; new newline test for all shells; the raw-tab test skips for fish with a reason; tests are async |
| `tests/install/shell-rc.test.ts` | `await` on the end-to-end zsh run (the runner is async now) |
| `docs/leftoff-implementation-plan.md` | **Part C:** Task 4 text (§8.1–8.4 and the pty test approach), the shared ignore helper in Tasks 6/7, file tree |
| `docs/reports/task-05.md` | This report |
| `docs/reports/task-04.md` | §10 backfilled with Task 4's commit, the CI failure and your answers |
| `docs/PROGRESS.md` | Task 4 hash and decisions backfilled, Task 5 marked done |

## 3. Interfaces produced

**`src/collectors/git.ts`**

- `gitCollector: Collector`:
  - `name`: `'git'`;
  - `isAvailable()`: `git --version` succeeds;
  - `collect(ctx)`: see §4.
  - **Cursor:** one row per project, key = project root, value = JSON `{ "commit": "<last HEAD seen>", "reflogAt": "<ISO time of newest switch seen>", "reflogKeys": ["<dedupe keys at that second>"] }` (see §8.1).
  - **Warnings:** `git not found on PATH`, or `git failed in <root>: <reason>`.

  Used by Task 8 (registry and ingest).
- `interface WorkingState { branch: string | null; files: { path: string; status: string }[]; diffStat: string | null }`: a name for the plan's `ReturnType<typeof readWorkingState>`.
- `readWorkingState(root: string): WorkingState`:
  - **Synchronous** (the plan's signature has no Promise), and never throws.
  - `status` is one of `modified`, `added`, `deleted`, `renamed`, `copied`, `untracked`, `conflicted`.
  - `files` are sorted by path.
  - `diffStat` is git's summary line, e.g. `1 file changed, 2 insertions(+)`, or `null` when clean or when there are no commits.

  Used by Task 9 (`buildFacts`), 10 (`resume`), 11 (loose ends), 13 (hooks), 14 (`brief --auto`).

**Test helpers** (`tests/shell/run-shell.ts`, changed):
- `runInteractive(...)` now returns `Promise<ShellRun>`.
- New `cannotRun(shell): string | null` returns the skip reason (`… is not installed` or `no \`script\` command to run fish under a pseudo-terminal`).

## 4. How it works

### Part A: fish under a pseudo-terminal

Your diagnosis was right: fish only emits `fish_preexec`/`fish_postexec` when it reads from a terminal. Getting `script` to work from Node on macOS took two more discoveries:

1. **macOS `script` rejects a socket or a FIFO as stdin or stdout** (`script: tcgetattr/ioctl: Operation not supported on socket`). Node gives child processes sockets, and a FIFO failed the same way when I tried it from a plain shell. An ordinary shell pipe works.
2. **macOS `script` sends `^D` to the child as soon as its stdin reaches EOF**, so fish quit before running anything (first probe: no log at all). Stdin must stay open until fish exits by itself on the final `exit`.

The helper therefore runs a small `sh` pipeline:

```ts
const pipeline =
  '{ cat "$0"; while [ ! -e "$1" ]; do sleep 0.05; done; } | ' +
  '{ d=$1; o=$2; shift 2; script "$@" > "$o" 2>&1; s=$?; : > "$d"; exit $s; }';
spawn('sh', ['-c', pipeline, files.input, files.done, files.output, ...scriptArgs], ...)
```

- The left side feeds the typed input, then keeps the pipe open until the right side creates the `done` file.
- The right side runs `script` with its output in a file and returns its exit status. The terminal output comes back as `stdout`.

The two `script` forms (detected once, in this order):

| Form | Command | Detected by |
|---|---|---|
| util-linux (Linux) | `script -qec "<quoted cmd>" /dev/null` | `script -qec true /dev/null` exits 0 |
| BSD (macOS) | `script -q /dev/null <cmd> <args…>` | `script -q /dev/null true` exits 0 |

If neither works, the fish block shows a `skipped: no \`script\` command to run fish under a pseudo-terminal` line and skips all its tests (demonstrated in §6). zsh and bash run exactly as before (stdin piped, then closed).

**Previously vacuous tests**, now proving the hook is active in the same run:

| Test | Session typed | Must hold |
|---|---|---|
| `LEFTOFF_INTERNAL=1 records nothing; the same session records once it is unset` | starts with `LEFTOFF_INTERNAL=1` in the environment: `echo internal-run`, then unset it (`set -e` / `unset`), `echo normal-run` | `echo normal-run` **is** recorded; `internal-run` is not |
| `a missing log directory records nothing and prints nothing; creating it starts recording` | starts without `~/.leftoff/shell`: `echo before-dir`, `mkdir -p …/shell`, `echo after-dir` | `echo after-dir` **is** recorded; `before-dir` is not; no hook error printed |

The "prints nothing" check is now the pattern `shell.log | No such file | Permission denied | leftoff.<shell>: | leftoff.fish (line`. The old check (`/leftoff/` anywhere) can't work under a pty, because the pty echoes what was typed, including `source …/leftoff.fish`.

**Raw tab vs fish:** under a pty, fish's line editor treats a typed tab as completion, so a raw tab can't be typed. That test is skipped for fish only. A new test, `a newline inside a quoted command becomes a space`, runs for all three shells and exercises the same replacement code.

As you noted, under a pty the `source …` line and the final `exit` are recorded for fish. No test asserts an exact list of lines, so these are tolerated.

### Part B: does CI compile better-sqlite3?

**No.** The evidence:
- **CI logs** (run 40330385429): on Node 24/26, npm prints `npm warn install-scripts better-sqlite3@13.0.3 (install: node-gyp rebuild)`. Every job's `npm ci` took 4–11 s, with no compiler lines.
- **Locally:** `npm ci --foreground-scripts` shows npm *does* run an inferred `node-gyp rebuild` (because `binding.gyp` exists). It ends `gyp info ok` with no `CC`/`CXX` lines and no `build/Release/*.node`, and the whole `npm ci` took 2.6 s.
- **Why:** better-sqlite3's own `binding.gyp` says it outright: *"npm's implicit node-gyp rebuild should do nothing when the package contains a prebuild for the host"*. Its targets only build when `force_build==1 or prebuild_exists==0`.

So what you saw on Linux was node-gyp starting and then building nothing. One consequence to keep for Task 18 is in §9.3.

### Task 5: commits

```ts
const format = `--format=%H${FIELD}%aI${FIELD}%s${RECORD}`;
const firstRun = ['log', format, `--since=${iso(ctx.now - 7 days)}`, 'HEAD'];
if (cursor === null) out = await git(root, firstRun);
else try {
  out = await git(root, ['log', format, `--since=${iso(ctx.now - retentionDays)}`, `${cursor}..HEAD`]);
} catch (err) {
  out = await git(root, firstRun); // cursor commit gone (rebase + gc); dedupe absorbs repeats
}
```

1. **HEAD:** `git rev-parse --verify -q HEAD`. If there are no commits yet, there are simply no commit events.
2. **First run:** commits on HEAD from the last 7 days (plan).
3. **Later runs:** `<cursor>..HEAD`, bounded by `retentionDays`. Without that bound, switching from a feature branch to a long-lived `main` would list everything on `main` since the fork point, and those events would be pruned anyway.
4. **A cursor commit that no longer exists** (rebased and garbage-collected) falls back to the first-run query. Dedupe keys `dedupeKey('git', root, hash)` make the repeats harmless.
5. **Event:** `kind` `commit`; `ts` = author date in UTC; `summary` = subject; `data` = `{ hash }`; `sessionRef` = `null`.
6. **New cursor:** the current HEAD.

Field and record separators (`\x1f`, `\x1e`) are used instead of newlines, so no subject text can break parsing.

### Task 5: branch switches

```ts
git log -g -n1000 --date=iso-strict --format=%H\x1f%gd\x1f%gs\x1e HEAD
```

Each reflog entry gives the commit, a selector like `HEAD@{2026-10-26T19:20:51+05:30}`, and a subject like `checkout: moving from main to feature/forgot-password`. I checked against git 2.50 that `git switch` writes the same subject as `git checkout`.

- Only `checkout: moving from X to Y` entries become `branch_switch` events: summary `Switched from X to Y`, `data` `{ from, to }`, `ts` = reflog time in UTC.
- **Reflog times have one-second resolution,** so "after the cursor time" isn't precise enough. The cursor stores the newest switch's second **and** the dedupe keys already emitted at that second. A later switch in the same second is still emitted, exactly once (tested).
- **Identical entries** (same second, same commit, same message, e.g. a script switching back and forth) get an occurrence number in their dedupe key, counted oldest first. Found by the test: without it the second identical switch was silently treated as already seen.
- **First run:** switches from the last 7 days. Only the newest 1000 reflog entries are read per run.

### Task 5: which projects

`repo.projects()` roots plus `ctx.projectFilter`:
- projects inside `LEFTOFF_HOME` are skipped (recursion guard);
- a folder that isn't a git repo is skipped **silently**, because non-git projects are normal (P5);
- "git not found" stops the loop with one warning;
- any other failure (timeout, corrupt repo) is a warning for that project, and the others continue.

### Task 5: readWorkingState

```ts
const entries = gitSync(root, ['status', '--porcelain=v2', '--branch', '-z']).split('\0');
// '# branch.oid <sha|(initial)>', '# branch.head <name|(detached)>',
// '1 XY … path', '2 XY … Rscore path' + '\0origPath', 'u XY … path', '? path'
...
const branch = head === '(detached)' ? `detached@${oid.slice(0, 7)}` : head || null;
const diffStat = oid === '(initial)' ? null : gitSync(root, ['diff', '--shortstat', 'HEAD']).trim() || null;
```

- **One `git status` call** gives the branch, the commit and every changed file. `-z` keeps paths with spaces or quotes intact.
- **Repo with no commits:** porcelain v2 reports the branch name directly (`branch.oid (initial)`, `branch.head trunk`), so the separate `git symbolic-ref` call the plan suggests isn't needed.
- **`diffStat`** uses `git diff --shortstat HEAD` (staged + unstaged), which prints exactly the summary line the plan gets with `--stat | tail -1`.

### Not disturbing your git

Every call adds:
- `GIT_OPTIONAL_LOCKS=0`: `git status` normally takes `index.lock` to refresh the index, which can make *your* concurrent `git commit` fail with "index.lock exists";
- `GIT_TERMINAL_PROMPT=0` and `LC_ALL=C`;
- `-c color.ui=false -c log.showSignature=false -c core.quotepath=off`, so your own git config can't change the output being parsed.

### Bug fix: in-word "flags" in redaction (Task 3 module)

The git tests were the first to put the §1.1 scenario's real names through `makeEvent`, and they came out wrong:

```
- "summary": "Added reset-token migration",
+ "summary": "Added reset-token [REDACTED]",
- "Switched from feature/forgot-password to main",
+ "Switched from feature/forgot-password [REDACTED] main",
```

The `--name value` rule matched `-token` inside `reset-token` and `-password` inside `forgot-password`. Fix: a flag must start the text or follow whitespace.

```ts
/(^|\s)(--?[A-Za-z][A-Za-z0-9_-]*)(\s+)("[^"]*"|'[^']*'|[^\s"'-][^\s"']*)/g
```

`-password hunter2` at the start and `tool<TAB>--token abc` are still redacted (tested).

## 5. Design decisions

| Decision | Alternatives | Why |
|---|---|---|
| fish through `script` via an `sh` pipeline with input file and done marker | Node spawn with pipes; a FIFO; `(cat; sleep N)` | Node's sockets and FIFOs are rejected by macOS `script`; EOF kills fish; a fixed sleep would slow every test |
| Prove vacuous tests non-vacuous within the same run | A separate control run | Same shell, same environment: if the hook isn't registered, the test fails |
| fish raw-tab test skipped with a reason; newline test added for all shells | Drop the tab test | zsh/bash still prove tab removal; fish proves the same code path with a newline |
| One cursor row per project with JSON `{ commit, reflogAt, reflogKeys }` | Plan: value = last commit hash only | The plan also needs a reflog cursor, which a hash can't express; second-level reflog times need the keys. One row per project, no growth |
| `<cursor>..HEAD` bounded by `retentionDays` | Unbounded | Switching to a long-lived branch would otherwise import its whole history since the fork point |
| Vanished cursor commit → first-run query | Warn and stop | Rebases are normal; dedupe makes repeats free |
| Commit `ts` = author date (`%aI`, plan) | Committer date | Plan's format; matches "when the work was written" |
| Only HEAD's history | All local branches (`--branches`) | Plan: "commits after the cursor" on the current line of work. Commits on branches you left aren't lost: they show when you return to the branch |
| Reflog read limited to the newest 1000 entries | Whole reflog | Keeps output under `maxBuffer` and the run fast; older entries are outside every window |
| `readWorkingState` synchronous | Async | Matches the plan's signature (`ReturnType<typeof readWorkingState>` used directly in `buildFacts` deps) |
| One `git status --porcelain=v2 --branch -z` call | status + symbolic-ref + rev-parse | Fewer processes on the 300 ms `brief --auto` path |
| `git diff --shortstat HEAD` | `git diff --stat \| tail -1` (plan) | Same summary line, no shell pipe; includes staged changes, which are uncommitted too |
| Status words `modified/added/deleted/renamed/copied/untracked/conflicted` | Raw `XY` codes | The brief prints `email_service.py (modified, uncommitted)` (§1.1) |
| Files sorted by path | git's order | Deterministic output and goldens |
| `GIT_OPTIONAL_LOCKS=0` | Default | Avoids `index.lock` collisions with the user's own git commands |
| Detached branch shows 7 hex chars | `git rev-parse --short` | One fewer call; plan says `<short-sha>` |
| Only git **timeouts and other failures** are logged by `readWorkingState` | Log every failure | "Not a repo" and "git missing" are normal and would flood the log |

## 6. Tests

### Part A: fish tests from a real run (your step 3)

fish 4.9.3 (Homebrew), macOS, `npx vitest run --project unit --reporter=verbose tests/shell tests/install`:

```
 ✓ |unit| tests/shell/hooks.test.ts > fish hook > records successful and failing commands with exit code, pid and cwd
 ✓ |unit| tests/shell/hooks.test.ts > fish hook > a command typed with a leading space is not recorded
 ✓ |unit| tests/shell/hooks.test.ts > fish hook > LEFTOFF_INTERNAL=1 records nothing; the same session records once it is unset
 ✓ |unit| tests/shell/hooks.test.ts > fish hook > a missing log directory records nothing and prints nothing; creating it starts recording
 ✓ |unit| tests/shell/hooks.test.ts > fish hook > the log file is created with mode 0600
 ↓ |unit| tests/shell/hooks.test.ts > fish hook > a real tab in a command becomes a space, so a line always has 6 fields
 ✓ |unit| tests/shell/hooks.test.ts > fish hook > a newline inside a quoted command becomes a space
 (… all 7 zsh, 7 bash, 4 zsh-detail, 5 bash-detail and 12 installer tests ✓ …)
      Tests  41 passed | 1 skipped (42)
```

A real fish log under the pty (manual probe before writing the helper; temp path shortened):

```
1793022188000  0    0  6688  /Users/apple/leftoff  source /Users/apple/leftoff/shell/leftoff.fish
1793022188000  0    0  6688  /Users/apple/leftoff  cd <tmp>/w
1793022188000  0    0  6688  <tmp>/w               echo hi
1793022188000  1    6  6688  <tmp>/w               ls /nope-leftoff
1793022189000  0  207  6688  <tmp>/w               sleep 0.2
1793022189000  0    0  6688  <tmp>/w               echo "a b"
1793022189000  0    0  6688  <tmp>/w               exit
```

` echo hidden` (typed with a leading space) is absent. `ls` exits 1 on macOS (2 on your Linux run); the test only asserts "not 0".

**Before the fix**, the same tests on this machine (reproducing CI):

```
     × records successful and failing commands with exit code, pid and cwd
     × a command typed with a leading space is not recorded
     × the log file is created with mode 0600
     × a real tab in a command becomes a space, so a line always has 6 fields
      Tests  4 failed | 2 passed | 21 skipped (27)
```

**Mutation checks on the fish hook:**

| Break | Result |
|---|---|
| Hook registered on an event that never fires (**the vacuous case**) | **all 6** fish tests fail, including the two that used to pass |
| `LEFTOFF_INTERNAL` check removed | `LEFTOFF_INTERNAL=1 records nothing; …` fails |
| Log-directory check removed | `a missing log directory …` fails |
| Leading-space check removed | `a command typed with a leading space …` fails |

**Skip reason, demonstrated** (`PATH` without `/usr/bin`, so no `script`):

```
 ↓ |unit| tests/shell/hooks.test.ts > fish hook > skipped: no `script` command to run fish under a pseudo-terminal
 ↓ |unit| tests/shell/hooks.test.ts > fish hook > records successful and failing commands with exit code, pid and cwd
 ...
```

### Task 5

**RED** (`npx vitest run --project unit tests/collectors/git.test.ts`):

```
 FAIL  |unit| tests/collectors/git.test.ts [ tests/collectors/git.test.ts ]
Error: Cannot find module '../../src/collectors/git.ts' imported from .../tests/collectors/git.test.ts
```

**Failures during GREEN that changed code:**
1. The redaction bug (§4): the diffs are shown there. Regression tests went in first (`tests/model/redact.test.ts`). 1 of the first 4 failed; the 3 others passed by luck (a quoted `-m "…"` value, or no value after the word), so I added the bare commit subject, and then 2 failed. Fixed; all pass.
2. `emits branch_switch from reflog`: `expected [] to deeply equal [ 'Switched from main to feature/forgot-password' ]`. The identical-entry case (§4); fixed with the occurrence number.
3. `tsc` type errors (number passed to `iso()`; an optional env object). Fixed.

**Mutation checks (git collector, code restored after each):**

| Break | Caught by |
|---|---|
| First-run window 70 days | `the first run only takes commits from the last 7 days` |
| Commits left newest first | `emits commits after cursor once` |
| Commit cursor not advanced | `emits commits after cursor once`, `emits branch_switch from reflog` |
| No occurrence number | `emits branch_switch from reflog` |
| Reflog cursor keys ignored | `emits branch_switch from reflog` |
| Detached HEAD not recognized | `detached HEAD → detached@<short-sha>` |
| `deleted` reported as `modified` | `staged added, deleted and renamed files, and paths with spaces` |
| Non-git folders produce warnings | `checks known projects plus the project filter; skips non-git folders silently` |
| `LEFTOFF_HOME` projects read | `projects inside LEFTOFF_HOME are ignored` |
| No fallback for a vanished cursor commit | `a cursor pointing at a commit that no longer exists falls back to the last 7 days` |

**Tests and what each proves**

`tests/collectors/git.test.ts` (17)

| Test | Proves |
|---|---|
| emits commits after cursor once *(plan)* | Ascending order; nothing on the second run after commit; only the new commit after `c` |
| a commit event carries hash, author date (UTC) and subject | All event fields; `+05:30` → UTC; **the §1.1 subject is not redacted** |
| the first run only takes commits from the last 7 days | Window measured from `ctx.now` |
| a cursor pointing at a commit that no longer exists falls back to the last 7 days | No warning, events returned |
| re-reading without a commit yields the same dedupe keys | Ingest failure, then retry |
| emits branch_switch from reflog *(plan)* | Both switches, `data.from/to`, nothing on re-run, a same-second switch emitted once; **`feature/forgot-password` not redacted** |
| checks known projects plus the project filter; skips non-git folders silently | Both sources of roots; no warning for non-git |
| projects inside LEFTOFF_HOME are ignored | Recursion guard |
| git missing on PATH → warning, no throw; isAvailable false *(plan)* | |
| readWorkingState lists modified and untracked files *(plan)* | The plan's exact expectation |
| branch name and diff stat summary line | `feature/forgot-password`; `1 file changed, 2 insertions(+)` |
| a clean repo has no files and diffStat null | |
| staged added, deleted and renamed files, and paths with spaces | Status words; `-z` paths; rename's old-path record skipped |
| detached HEAD → detached@<short-sha> *(plan)* | |
| a repo with no commits: branch from HEAD, files listed, no diff stat *(plan)* | |
| not a repo → empty state, no throw *(plan)* | |
| git missing on PATH → empty state, no throw | |

`tests/model/redact.test.ts` (regression, 7 new)

| Test | Proves |
|---|---|
| a -name inside a word is not a flag ×5 | `Added reset-token migration` (bare and inside `git commit -m "…"`), `git checkout feature/forgot-password`, `Switched from feature/forgot-password to main`, `npm run reset-password -- --dry-run` unchanged |
| a flag at the start or after whitespace is still redacted ×2 | `-password hunter2 …` and `tool<TAB>--token abc` |

**Final run** (`npm run check`):

```
> tsc --noEmit && eslint . && prettier --check . && vitest run --project unit

Checking formatting...
All matched files use Prettier code style!

 Test Files  13 passed (13)
      Tests  228 passed | 1 skipped (229)
   Duration  3.40s
```

229 = 196 + 6 (fish tests now run instead of skipping) + 3 (newline test × 3 shells) + 7 (redaction regression) + 17 (git). The 1 skipped is the fish raw-tab test, by design.

## 7. Edge cases and failure handling

| Situation | Behavior |
|---|---|
| git not installed | `isAvailable` false; `collect` returns one warning and no events; `readWorkingState` returns the empty state |
| Project folder isn't a git repo | Skipped silently by the collector; empty state from `readWorkingState` |
| Repo with no commits | No commit or switch events; `readWorkingState` reports branch and files, `diffStat: null` |
| Detached HEAD | `branch: 'detached@1a2b3c4'`; commits on HEAD still collected |
| Cursor commit rebased away | Falls back to the 7-day query; duplicates absorbed by dedupe |
| History rewritten (amend) | The amended commit has a new hash, so it's a new event; the old one stays in the store (see §9.2) |
| Many switches within one second | Each emitted exactly once (keys at the cursor second, plus occurrence numbers) |
| Very long reflog | Newest 1000 entries only |
| git hangs (network filesystem, huge repo) | Killed after 1000 ms → warning for that project (collector) / empty state + one log line (`readWorkingState`) |
| Huge `git status` output (> 1 MB) | Treated as a failure → empty state + log line |
| User running git at the same time | `GIT_OPTIONAL_LOCKS=0`: we never take `index.lock` |
| User's git config (signing display, colors, quoted paths) | Overridden per call; output is stable |
| Paths with spaces, quotes, non-ASCII | `-z` and `core.quotepath=off` |
| fish tests where `script` is missing | Skipped with a visible reason |

## 8. Deviations from the plan

1. **Git cursor value is JSON** `{ commit, reflogAt, reflogKeys }` instead of "the last seen commit hash". The plan also needs a reflog cursor ("after the cursor time"), and with one-second reflog times a time alone can't tell which entries in that second were already emitted. Still one row per project, as the plan's key says. Same idea as the shell cursor you approved.
2. **`<cursor>..HEAD` is also bounded by `retentionDays`**, to avoid importing a long-lived branch's whole history after a branch switch.
3. **`git diff --shortstat HEAD`** instead of `git diff --stat | tail -1`: same summary line, and it includes staged changes.
4. **No `git symbolic-ref` call for repos without commits:** porcelain v2 already reports the branch.
5. **Redaction fix in `src/model/redact.ts`** (Task 3's module), with regression tests: the plan's rule "flags whose name matches …" now only applies to real flags at a word start.
6. **Part A:** `runInteractive` is async for all shells. zsh and bash are still run the same way (stdin piped then closed); only the call style changed.

## 9. Open questions and risks

1. **Teammates' commits after `git pull` will show as "Done".** The plan takes every commit on HEAD after the cursor. After `git pull` (fast-forward or merge), other people's commits are on HEAD, so the brief's `Done` list and the standup's "Yesterday" would include work you didn't do, plus `Merge branch 'main' of …` merge commits. This is a personal tool (D2), so I propose to **only take commits whose author email equals `git config user.email`** (when set), and to **skip merge commits** (`--no-merges`). I haven't done it, because it changes what "Done" means. Your decision; it fits in Task 6's commit as a fold-in.
2. **Amended or rebased commits leave the old version in the store.** E.g. `Added reset-token migration` plus its amended twin, both listed as "Done". Task 9 could drop commit events whose hash is no longer reachable, or dedupe by subject within a window. Flagging for Task 9; no change now.
3. **Fresh machines without Python (Task 18).** npm's inferred `node-gyp rebuild` for better-sqlite3 starts Python even though it then builds nothing. On a fresh macOS without the Command Line Tools, `python3` is a stub that opens an install dialog. `npm i -g @leftoff-dev/cli` might then stall or fail. The Task 18 fresh-machine check should include "no Xcode CLT installed". I'll put it on that checklist.
4. **Task 11 needs to tell "git timed out" apart from "not a repo".** The plan's `? git status unavailable` line can't tell from `readWorkingState`'s return value, which is the same empty state in both cases. Task 11 can measure the time itself, or `WorkingState` could gain an `unavailable?: true` field (an interface change). I'll ask at Task 11.
5. **`ignore.projects` in the git collector.** Your §9.4 answer covers Claude and Codex in Tasks 6/7. Git only looks at projects other collectors already stored (which respect the ignore list), plus `projectFilter`. If you also want the git collector to apply the list (for `leftoff resume --project <ignored>`), that's one line in Task 6 with the shared helper.

## 10. Commit

To be filled in by Task 6's commit (B11). The commit message is `feat(git): git collector and working state`.
