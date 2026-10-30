# Task 15b: Human-readable briefs

You came back to `~/leftoff` after two days and leftoff couldn't tell you where you left off. This step fixes that. The proof on your real data is in §6, and the open questions are in §9.

**Short version.** The auto brief, `leftoff resume` and the agent context now open with plain words: what you asked, what the agent last said, what got done, where it stopped, and how to pick up. On your data, the `~/leftoff` brief now says *"Claude's last update: Task 15 is committed as `7548819` (not pushed)…"*, *"Still open: nothing, all changes committed"*, and what to do next. Before, it listed 9 "still failing" problems that weren't real.

Fixing it turned up four bugs that only real data could show. All are fixed here:

1. **The git collector had never recorded one of your commits.** `--author=<email>` is a basic regex, and the old code escaped `+` as `\+`, which means "one or more". Your noreply address `163647086+…@users.noreply.github.com` matched nothing, so "Done" could never show a commit. ~/leftoff now has 19 commits recorded (it had 0).
2. **Running `leftoff resume` hid your work.** Opening a terminal and running `leftoff resume` / `git log` at 15:38 made a new "session", and the brief summarized that instead of Task 15. On a snapshot taken a few minutes later, the brief was empty.
3. **Subagent prompts read as yours.** Claude's subagent transcripts share the parent session. In LoopLint, "You asked" showed a review prompt Claude had written for a subagent.
4. **A pause read as a done-claim.** *"Your usage limit was reached, so I've paused the build… so no finished work will be redone"* counted as "done".

One commit, `feat(brief): human-readable briefs` (not pushed). I amended this report into it after the proof run.

## 1. Goal

A returning developer should read where they left off in plain words, in under ten seconds. The exact details stay one flag away (`leftoff resume --details`). Problems that aren't real problems never show up.

## 2. Files

**Created**
- `src/brief/failure-words.ts`: the data table that puts failures in words, plus `failureCategory`, `isWholeProjectRun`, `resolvedCategories`.
- `src/render/narrative.ts`: `narrativeLines`, `renderBrief`, `plainNextStep`.
- Tests: `tests/brief/failure-words.test.ts` (48 cases) and `tests/render/narrative.test.ts`. New golden file `tests/render/golden/rahul-brief.txt`.

**Modified**
- Facts and rules: `src/brief/facts.ts`, `next-step.ts`, `loose-ends.ts`.
- Collectors:
  - `src/collectors/scratch.ts`: `referencesTempDir`, `isAgentToolError`;
  - `src/collectors/claude.ts`: `data.head`, subagents;
  - `src/collectors/codex.ts`: `data.head`;
  - `src/collectors/git.ts`: fixed-string author, re-read, email log marker.
- Renderers: `src/render/auto.ts`, `markdown.ts` (agent context), `terminal.ts` (3 problems), `loose-ends.ts` (3 problems).
- Commands:
  - `src/cli/commands/resume.ts`: narrative by default, plus `--details`;
  - `src/cli/commands/brief-auto.ts`: polished summary first;
  - `src/cli/commands/loops.ts`: filter seam;
  - `src/cli/commands/setup.ts`, `doctor.ts`;
  - `src/cli/index.ts`.
- Helpers: `src/install/shell-rc.ts` (`shellHookLine`, `isCurrentShellHook`), `src/store/repo.ts` (`hasSource`), `src/model/event.ts` (`programWords` exported).
- Tests for all of the above. The old test strings that named your LoopLint crate now use a made-up crate name of the same length (`payments_adapters`), so no test names your projects or paths.
- Docs: the plan (§1.8 narrative brief, new Task 15b section), `docs/PROGRESS.md`.

## 3. Interfaces

- `BriefFacts.lastAgent: { source, update, question } | null`. This is the only new facts field. Every other field keeps its shape, and `--json` stays `{ facts, polished }`.
- `describeFailure(command, error) → { category, now, still, fix }`.
- `failureCategory(cmd)`, `isWholeProjectRun(cmd)`, `resolvedCategories(category)`.
- `narrativeLines(facts, polished, { now, width, maxChars? })` and `renderBrief(facts, polished, { color, now })`.
- `renderAutoBrief(facts, { color, now, polished? })`.
- `ResumeOptions.format` adds `'details'`, and the CLI adds `--details`.
- `ProjectFilter`, `isRealProject`, `defaultProjectFilter`, plus `buildLooseEnds({ …, filter? })` and `runLoops(opts, { filter? })`.
- `Repo.hasSource(root, source)`.
- `shellHookLine(rc)` and `isCurrentShellHook(shell, rc, script)`.

## 4. How it works

### A. The narrative

```
myapp · 14h ago · branch feature/forgot-password
  You asked: Add a forgot-password flow: endpoint, reset token, email
  Claude's last update: The SMTP server still refuses the connection on both ports.
  Done: Added reset-token migration · Built POST /auth/forgot-password endpoint
  It stopped with: `python scripts/send_test_email.py` — SMTP connection refused
  Still open: 1 uncommitted file
  Pick up with: Get `python scripts/send_test_email.py` working (SMTP connection refused)

Exact commands, errors and attempts: `leftoff resume --details`
```

**Line 1** is `<project> · <when> · branch <branch>`. `<when>` is the end of the last *work* session. It is not the newest event, because opening a terminal shouldn't make two-day-old work look fresh.

**A cached polished summary** comes right after line 1 when its facts hash matches. This is new in the auto brief, which never showed polish before.

**"You asked"** is the last request:
- pasted-content tags are dropped;
- Claude's "session is being continued…" summaries are skipped;
- `[Request interrupted by user]` is skipped.

**"\<Agent>'s last update"** is the first one or two sentences of the agent's final message:
- markdown `**` is dropped;
- the second sentence is only added when the first is short;
- a final question is not repeated here.

To make this possible, the collectors now keep a long message's *start* in `data.head`. The summary still keeps its end, which is where a question would be. Messages stored before 15b have only their end, so they show their first complete sentence (§8).

**"Done"** lists commit subjects newest first, two at most, then `(+N more)`, then the edited files.

**The claim sentence** reads, for example: `Claude said "All tests pass", but the billing tests are still failing.`
- In the terminal, a long quote is shortened *inside* the quote, so the `", but …` part always shows.
- When the claim names the top problem, there is no separate "It stopped with" line.

**"It stopped with"** names the top problem in words. "Still open" then counts the rest: `N more problems · M uncommitted files`.
- Zero parts are left out.
- `all changes committed` appears when git says so.
- `nothing, all changes committed` appears when nothing is open.

**"Note:"** lines show every note (P11). The newest `next:` note becomes the next step instead.

**"Pick up with"** takes the first of these that applies:
1. a `next:` note;
2. *the agent's final question*: `Answer Claude's question: …`. An offer such as "tell me if you want…" or "should I…" counts as a question;
3. the claimed problem's fix;
4. the top problem's fix;
5. `Review and commit N uncommitted files (a, b, c and 1 more)`;
6. `Start the next task (everything from the last session is committed)`;
7. `Continue: <request>`.

`chooseNextStep` (`facts.nextStep`) gets the same question rule, so `--details`, `--json` and polish agree.

**Where it is used.**
- The auto brief is the narrative plus `Run \`leftoff resume\` for details`.
- `resume` is the narrative plus a pointer to `--details`.
- `resume --details` is the Task 10 brief, unchanged apart from capping problems at 3.
- The agent context is the narrative, then `Open problems (unresolved)` (each with `Already tried (did not fix it)`), then `Uncommitted changes`, all within 4000 characters.
- `--md` and `--json` are unchanged.

### C. Failures in words: one data table

`TOOLS` in `failure-words.ts` maps a pattern on the program words to a category and a label. Setup steps, runners (`npx`, `uv run`, …), `python -m` and trailing filters are removed before matching.

| Category | Tools | Phrase |
|---|---|---|
| test | pytest, jest, vitest, mocha, `node --test`, `go test`, `cargo test`/`nextest`, gradle, maven, scripts named `test*`/`*:test`, `make test` | "the reset tests are failing". The scope is a `-p` package or the test files' names, else the runner ("the Go tests") |
| lint | ruff, eslint, flake8, pylint, golangci-lint, clippy, biome, `lint` scripts | "ESLint reports lint errors" |
| format | prettier, `ruff format`, `cargo fmt` and black, in check mode | "Prettier finds unformatted files" |
| typecheck | tsc, vue-tsc, mypy, pyright, `typecheck` scripts | "TypeScript reports type errors" |
| build | vite/next/… build, webpack, tsup, rollup, esbuild, cargo/go/swift/dotnet build, `cargo check`, gradle build, mvn package/install/compile/verify, `build` scripts | "the build fails" |
| check | `check` scripts, `make check` | "the project checks fail" |
| make / docker | `make <target>`, `docker build` | "\`make deploy\` fails", "the Docker build fails" |
| missing | any tool, decided by the error: `Missing script: "x"`, and `command not found` in zsh, bash and sh | 'there is no "lint" script in package.json', "\`pnpm\` is not installed" |
| (unknown) | anything else | "\`./deploy.sh --stage\` — connection refused" |

Each row has a `now` form, a `still` form ("are still failing") and a `fix` form ("Make the reset tests pass (\`pytest tests/test_reset.py\`)").

### B. Failures that are not open problems

The rules live in `problemGroups`, which feeds both the open problems and the claims.

- **Agent tool errors** never count, from the agent sources: `<tool_use_error>`, a line starting `Blocked:`, "The user doesn't want to proceed with this tool use", "Permission to use X … has been denied", "rejected by user", "[Request interrupted by user".
  - A plain `Permission denied` / `EACCES` still counts, because that is the project's own problem.
- **Temp-folder commands are scratch**, from any source: `/tmp`, `/private/tmp`, `/var/folders`, a `scratchpad` path, `$TMPDIR`, `mktemp`.
- **A passing whole-project check** resolves every earlier failure of its category. "Whole-project" means a categorized command with no file arguments (`.` and `./...` are fine), no test filter (`-k`, `-t`, `--grep`, `-run`, `-p`, `--package`, `-pl`, `--filter`, `-m`, `-g`) and no name after `--`.
  - A `check` script resolves tests, lint, format, types, build and check.
- **A commit after a passing check** resolves every failure from before that check. The commit can be a git event or a successful `git commit` command; your agent's own `git commit` counts. Failures after the check stay open.
- **At most 3 problems** are shown per project, newest first, in `--details`, loose ends and the agent context. The narrative shows one and counts the rest.
- **Window:** the last session that has *work* in it: an agent turn, an edit, a commit, a branch switch or a real failure. Later sessions that only looked around don't move it, but their commands still resolve failures.

### D. Loose ends: only real projects

`isRealProject` leaves out:
- folders under a temp dir: `/tmp`, `/private/tmp`, `/var/folders`, `os.tmpdir()` and its real path, or any `scratchpad` path segment;
- hash-named folders: 16+ hex characters, or a UUID;
- anything inside an agent config dir: `.claude`, `.codex`, `.cursor`, `.gemini`, `.aider`, `.continue`, `.windsurf`;
- folders that aren't a git repo (no `.git` at the root) and have no `shell` events.

Each project shows at most 3 problems, then `• +N more problems`.

### E/F. Polish, setup, doctor

**Polish first.** `brief --auto` reads the cached summary and shows it when the facts hash matches. `resume` already did this, and it now shows the summary right after line 1.

**`setup`:**
- With Claude Code installed, it asks *"Use Claude Code for AI summaries (recommended)? The brief facts go to Claude Code and Anthropic, with your Claude login."* The default is Yes, unless you chose another provider before.
- If you decline, the six options are listed, one line each with its privacy note, then "Which one?".
- The catch-up line reads `Caught up: 119 things from Claude Code, 2 terminal commands`. Zero parts are left out; with nothing, it reads `Caught up: nothing to read yet`.
- It ends with what it installed (hooks, plugin, polish, data folder), three things to try, and `To undo: run \`leftoff uninstall\` (…)`.

**`doctor`:**
- It checks the login shell's rc file and every other rc file that has a leftoff block.
- A block that runs another install's script is a warning that shows the line it runs, with the setup hint.

**`user.email is not set`** is logged once per repo. The marker is saved at once (`git-email` cursor), so a run that is never saved can't log it again.

**git re-read.** Cursors saved before the author fix have no `authorMatch` field. Their repo is read once more like a first run, and dedupe keys absorb any repeats. This happens on your next real ingest.

## 5. Design decisions

1. **The narrative is a renderer, the facts stay the facts.** `--json` keeps its shape and adds one field (`lastAgent`). `facts.nextStep` changes only to include the agent's question, so polish and `--details` say the same thing.
2. **The problem categories are the resolution rule too.** The same table decides both the phrase and which failures a passing whole-project run resolves, so the two can't drift apart.
3. **A commit only resolves failures with a passing check before it.** A bare "wip" commit after a failure resolves nothing (tested).
4. **The temp-folder rule applies to your own shell too,** as you asked ("any command"). This goes against an earlier rule ("your own shell commands are never scratch"), and I updated the plan to match.
5. **A paused agent isn't claiming done.** The check is message-level (`usage limit`, `rate limit`, `paused`, `ran out of …`) and reads both the start and the end of the message.
6. **The brief's "when" is the last work, the details header is the last event.** `--details` keeps `lastActiveAt` ("last active 35m ago" right after your 15:38 `resume`); the narrative says "2d ago". See §9.2.
7. **Subagent records** keep their commands and edits (real work in your project) but not their prompts or replies.

## 6. Proof on your real data

**Setup.** Your real `~/.leftoff` was copied with `sqlite3 .backup` into the scratchpad. Nothing in `~/.leftoff` was written: every run used `LEFTOFF_HOME=<copy>`, with collectors switched off in the copy. Your working trees were clean during the final runs (the code was already committed).

- **Before** is commit `7548819`, built in a scratch folder from `git archive`.
- **After A** is your stored events plus a git re-read only, so it shows what your real DB will look like.
- **After B** additionally re-reads your Claude transcripts with the new collector, so it shows what new sessions look like (opening sentences, no subagent prompts).

Both after copies are cut at 15:42 today, before this session started, to show the moment you came back. Your 15:38 `leftoff resume` / `git log` look-around session is still in them.

### 6.1 `~/leftoff`, polish off

**Before**, what you saw at 15:38 (auto brief, then `resume`):
```
Where you left off — leftoff (main) · last active 2d ago
  ✗ `sleep 100; … ks/bdzzsc3ts.output` — <tool_use_error>Blocked: sleep 100… (+8 more problems)
Run `leftoff resume` for details

Where you left off — leftoff (main) · last active 2d ago

Agent said done, but
  claude said: "…touched them, so tell me if you want that done; otherwise the new scripts arrive…
  ✗ `sleep 100; … tasks/bdzzsc3ts.output` — <tool_use_error>Blocked: sleep 100… (still failing)
  ✗ `npx vitest … unit tests/cli/doctor.test.ts tests/cli/setup.test.ts` — failed (still failing)
  ✗ `sqlite3 ~/.leftoff/leftoff.db … src/collectors/claude.ts` — failed (still failing)
  ✗ `SP=/private/tmp/claude-501/-Users-apple--claude-spares-spare-qPCfF3/…` — failed (still failing)
  ✗ `for i … run --project unit | grep -E -A12 "FAIL " | head -30; done` — failed (still failing)
  • +4 more
Done
  • Edited 3 files: tests/brief/facts.test.ts, docs/reports/task-14.md, docs/reports/task-15.md
Next step
  → Verify: `sleep 100; cat /private/tmp/claude-501/-Users-apple-leftoff/7dd00b1d-288b-4571-ae53-80…
```
(The `tried:` lines are left out here.)

**Before**, a few minutes later, after your `resume` and Claude's session start:
```
Where you left off — leftoff (main) · last active 1m ago

Sources: claude –  git –  shell –  codex –
```

**After B** (`brief --auto`; `resume` shows the same lines and ends with the `--details` pointer):
```
leftoff · 2d ago · branch main
  You asked: Task 14 approved. Great catch on shrink() dropping the command field. Answers to §9…
  Claude's last update: Task 15 is committed as `7548819` (not pushed), together with all your §9…
  Done: feat(cli): setup, doctor, status, forget, config, uninstall · feat: automatic brief on…
  Still open: nothing, all changes committed
  Pick up with: Answer Claude's question: I haven't touched them, so tell me if you want that…
Run `leftoff resume` for details
```

**After A** has the same lines except the update, because that message was stored before 15b with only its end:
```
  Claude's last update: Refreshing them is the same three files as before, with no rc change.
```

`resume --json`: `openProblems` 9 → **0**, `claimedDone` → `null`.

Where each of the 9 went:
- `sleep 100…`: an agent tool error;
- `SP=/private/tmp/…`, the `/private/tmp` `cat`, and the `mktemp` backups: temp folders;
- the `doctor`/`setup` vitest runs and the `for i … vitest` loops: resolved by the passing `npm run check`;
- `sqlite3 …`: resolved by the commit after that passing check.

### 6.2 LoopLint, polish off

**Before:**
```
Where you left off — LoopLint (feat/m0-m1) · last active 2d ago
  ✗ `cargo test -p looplint_adapters` — failed (+5 more problems)
Run `leftoff resume` for details
```
`resume` showed "Agent said done, but / claude said: "…records exactly where to pick up, so no finished work will be redone."", then six problems (the adapters run listed twice), "Done: Edited 10 files…" and "Next step → Verify: `cargo test -p looplint_adapters` still failing".

**After B** (`brief --auto`):
```
LoopLint · 6d ago · branch feat/m0-m1
  You asked: I hit my usage limit while you were working, but it has reset now. Please continue…
  Claude's last update: Your usage limit was reached, so I've paused the build. I stopped the one…
  Done: fix(adapters): unique keys, project-owned names, plain-function tools · feat(semantic)…
  Claude said "Tasks 0–10 are complete, with…", but the looplint_adapters tests are still failing.
  Still open: 4 more problems · all changes committed
  Pick up with: Make the looplint_adapters tests pass (`cargo test -p looplint_adapters`)
Run `leftoff resume` for details
```
- The claim is now the real one ("Tasks 0–10 are complete…"), not the pause message.
- In After A, "You asked" still shows the subagent's review prompt, because the old events can't tell subagent records apart (§8).
- LoopLint's problems are real: no passing workspace test run or commit came after them.

### 6.3 Loose ends (`leftoff`)

**Before:** 13 projects, including:
- `1eb15c1846f963b…`, `750fac67…` and `8e9999f8…` (hash folders);
- `leftoff-fixture`, `leftoff-codex-fixture` and `leftoff-hooktest` (`/private/tmp`);
- `scratch-2026-10-23-261b01` (an agent scratch workspace; its only problem was "The user doesn't want to proceed…");
- `Voice_Model` (not git, agent-only).

Orbit10 listed 16 problems.

**After** (A and B are the same):
```
Loose ends across 5 projects

Orbit10 (main) · 7d ago · stale
  ! Agent said "…chat; the progress document records the completed…" — 10 problems still failing
  ✗ `ollama serve` — exit code 137
  ✗ `npx --yes --package=node@24.22.1 --package=pnpm@11.3.0 pnpm test:real` — exit code 137
  ✗ `/Users/apple/.npm/_npx/88f263e117bb9f03/node_modules/node/b…` — Orbit10 · http://127.0.0.1:4310
  • +11 more problems
  • 23 uncommitted files
LoopLint (feat/m0-m1) · 2d ago
  ! Agent said "Tasks 0–10 are complete, with the Task 8 follow-up fixes…" — 5 tests still failing
  ✗ `cargo test -p looplint_adapters` — failed (5 attempts)
  ✗ `cargo fmt … cargo test --workspace | grep -E "FAILED|panicked|^error"` — failed (5 attempts)
  ✗ `cargo test … -- qualified_and_aliased run_agent_that_is star_import` — failed (5 attempts)
  • +2 more problems
dynavec (fix/issue-15-s3vectors-error-mapping) · 9d ago
  ! Agent said "The 51 existing relevant tests have also finished…" — 3 problems still failing
  ✗ `make run-ci` — /Library/Developer/CommandLineTools/usr/bin/make lint (2 attempts)
  ✗ `uv run … tests/test_s3vectors_errors.py` — unformatted: File would be reformatted (4 attempts)
  ✗ `uv run … navec/stores/async_s3vectors.py` — unformatted: File would be reformatted (5 attempts)
Earthquake-Detection-Using-Machine-Learning-on-Optical-Fiber-DAS-Data (main) · 29d ago · stale
  ! Agent said "Validation completed: `ruff` passed and all 14 tests…" — 2 problems still failing
  ✗ `uv run … src/dasquake/streaming.py` — UP035 [*] Import from `collections.abc`… (5 attempts)
  ✗ `git status … ruff check src/dasquake tests && uv run pytest` — M Final_Phase.ipynb (5 attempts)
  • 18 uncommitted files
hackerrank-orchestrate-october26 (main) · 5d ago · stale
  ! Agent said "Everything is committed (`ace6561`) and you can submit at…" — 2 uncommitted files
  • 2 uncommitted files

Run `leftoff resume` inside a project for details
```

### 6.4 Polish on (`claude-cli`, four real `claude -p` calls on copies)

**Before** (`resume --polish`, ~/leftoff): the paragraph repeated the false problems. It ended with *"Still open are a blocked `sleep 100; cat …` check, which was your suggested next step to re-verify, and failed runs of the `doctor`/`setup` vitest tests and a `test_failed` sqlite query."* The old auto brief never showed polish.

**After** (`resume --polish`, then `brief --auto`, ~/leftoff): the auto brief now shows the paragraph first.
```
leftoff · 2d ago · branch main
  On `main` in leftoff, your last session (Oct 27) covered the automatic brief on terminal open, the CLI commands setup, doctor, status, forget, config and uninstall, … Task 15 is committed as `7548819` (not pushed) along with those answers, the report, PROGRESS, and Task 14's hash `48a70ae`. Claude is waiting on one answer: the `~/.leftoff/shell` copies are still the Task 14 version with the old quiet-mode skip, so say if you want them refreshed (same three files, no rc change), otherwise the new scripts arrive with your next `leftoff setup`.
  You asked: …   (then the same lines as §6.1)
```
LoopLint after: *"…Tasks 0–10 were reported complete, but `cargo test -p looplint_adapters` is still failing, along with the workspace fmt/clippy/test run, the `openai_agents` tests and the semantic `dataflow` test. So the next step is to verify and fix the adapters tests…"*

## 7. Tests

**RED first.** Every new behavior had a failing test before its code:
- the phrase table and the scratch helpers failed with the module or function missing;
- the 29 facts, collector, git, render, setup and doctor cases failed on the assertion;
- the real-data fixes (interrupt marker, pause claim, claim fitting, subagents, pause read from the message start, newest-first Done) each got a test that failed before the fix.

The negative cases ("partial run doesn't resolve", "wip commit resolves nothing") passed from the start, as they should.

**Mutation pass.** I ran 17 mutations over the new rules: category resolution, the commit rule, agent errors, temp dirs, the work window, the author match, the re-read, the email marker, subagents, both project filters, the pause check, the part-of-suite flags, the question rule, polish in the auto brief, the doctor rc scan and the loose-ends cap.
- 16 were caught.
- One survived: dropping `--fixed-strings` *without* the old escaping still passed, because a bare `+` is literal in a basic regex. I strengthened the test with a `.` lookalike address, and that mutant is now caught.
- The sources were restored after each mutation (checked).

**Results**
- `npm run check`: tsc, eslint and prettier clean; 937 passed, 1 skipped (the platform skip from earlier tasks).
- `npm run test:e2e`: 3 passed.
- During the work, one full run failed `tests/ingest/background.test.ts` ("the spawned ingest is detached", a timing test). It passed alone and in every later full run (4).
- `dist/` is rebuilt, so your live hooks and shim run the new code.

## 8. Edge cases and limits

- **Old stored agent messages** have only their last 300 characters, so their "last update" is their first complete sentence (After A). New messages store their start.
  - I did not re-read your real Claude transcripts. Re-reading would bring back anything you `forget`, which breaks `forget`'s promise. See §9.1.
- **Old subagent events** can't be told apart, because the old events didn't store `isSidechain`. Only new sessions benefit.
- **A non-git folder you only used through an agent** (LoopLint-like work before `git init`, or `Voice_Model`) is left out of loose ends. It still has its own `leftoff resume`.
- **"Still open"** says `all changes committed` only when git gave a branch. Without git it doesn't claim anything.
- **The polished paragraph is prose:** it isn't cut, even in the auto brief (§9.3).
- **Long next steps** are cut at 100 characters in the terminal (`…tell me if you want that…`). The full text is in `resume --json` and the agent context.

## 9. Questions for you

1. **Re-read Claude transcripts once on your real DB?** It would fill in opening sentences, drop subagent prompts, and fix LoopLint's "You asked" today rather than from your next session on. The cost is that anything you ever `forget`-ed from Claude would come back. I'd do it only with your yes. The alternative is to leave it, and new sessions are already right.
2. **"When" in loose ends.** The brief says LoopLint was last worked on "6d ago" (last work), while loose ends says "2d ago" (last event, from leftoff's own test runs there). Should loose ends use last work too?
3. **Polish length in the auto brief.** It is 4 sentences, unwrapped, before the facts. Should the auto brief show only its first sentence, or keep it whole?
4. **Offers count as questions.** "tell me if you want that done" becomes "Answer Claude's question: …". OK?
5. Task 15's open item still stands: `setup` and `uninstall` haven't been run on your machine. With this step, `setup` would recommend claude-cli (your current choice) and print the new summary.
