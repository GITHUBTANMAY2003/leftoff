# Task 11: Standup and loose-ends commands

This commit has two parts:

- **A.** Your answers to Task 10 §9.1/§9.2: four readability changes to the brief.
- **B.** Task 11 itself: `leftoff standup`, and `leftoff` / `leftoff loops`.

§6.1 shows the re-rendered real-fixture briefs. §6.2 shows the new commands on the same real data.

## 1. Goal

**Part A (your answers, plus the three follow-up choices you made in this session):**
1. **Option (b):** a problem shown under "Agent said done, but" is left out of "Open problems".
   - Its `tried:` line moves with it (your choice).
   - This applies to the terminal and Markdown briefs. The agent context and `--json` keep every open problem (your choice).
2. **Failing command first:** `` `npm run lint` — Missing script: "lint" ``. With no command, the error text is shown alone.
   - Next step: `` Verify: `cmd` still failing ``.
   - Resolve uses the command plus the error: `` Resolve: `cmd` — error `` (your choice). This changes §1.1, §1.12 and the golden file.
3. **Lines capped at 100 characters** with `…`, in terminal output only.
4. **One status for unfinished files:** `calc.js (untracked)`.

**Task 11 (plan):**
- `buildStandup`, `renderStandup` and `runStandup`, with `--since`, `--all` and `--copy`.
- `buildLooseEnds`, `renderLooseEnds` and `runLoops`, with `--json`.
- Bare `leftoff` runs `loops`.
- The loose-ends golden file.

## 2. Files

| File | Purpose |
|---|---|
| `src/brief/facts.ts` | **A:** `OpenProblem.command`, `problemText`, `contradictionOf`, exit-code fallback. **B:** `OpenProblem.isTest`, `LooseEnds.gitUnavailable`, `editedPaths` and `shortList` (shared with standup) |
| `src/brief/next-step.ts` | **A:** `` Verify: `cmd` still failing `` and `Resolve: <problem text>` |
| `src/render/problems.ts` | **New (A):** `splitProblems`, the dedupe for "Agent said done, but" vs "Open problems" |
| `src/render/terminal.ts` | **A:** dedupe, `fit` / `LINE_WIDTH` (100), single status; `painter` exported for loose ends |
| `src/render/markdown.ts` | **A:** dedupe with `tried:`, problem text, single status; agent context uses problem text |
| `src/collectors/git.ts` | **B:** `WorkingState.unavailable` when git itself fails or times out |
| `src/render/standup.ts` | **New:** `buildStandup`, `renderStandup` |
| `src/cli/commands/standup.ts` | **New:** `runStandup`, `defaultSince`, `copyToClipboard` |
| `src/brief/loose-ends.ts` | **New:** `buildLooseEnds` |
| `src/render/loose-ends.ts` | **New:** `renderLooseEnds` |
| `src/cli/commands/loops.ts` | **New:** `runLoops` |
| `src/cli/index.ts` | `standup`, `loops`, bare `leftoff` → loops; shared `print` |
| `tests/render/standup.test.ts`, `tests/cli/standup.test.ts` | **New:** 9 + 9 tests |
| `tests/brief/loose-ends.test.ts`, `tests/render/loose-ends.test.ts`, `tests/cli/loops.test.ts` | **New:** 8 + 9 + 4 tests |
| `tests/render/golden/loose-ends.txt` | **New:** the §1.8 loose-ends example (see §5) |
| `tests/render/golden/rahul.txt` | **A:** command first, single status |
| `tests/brief/{facts,next-step,fixtures}.test.ts`, `tests/render/*.test.ts`, `tests/cli/resume.test.ts`, `tests/collectors/git.test.ts` | **A** and **B** test updates and additions |
| `docs/leftoff-implementation-plan.md` | §1.1, §1.7, §1.8, §1.12, and Task 11 notes and test literal |
| `docs/reports/task-11.md` | This report |
| `docs/reports/task-10.md` | §10 backfilled |
| `docs/PROGRESS.md` | Task 10 hash; Task 11 entry |

## 3. Interfaces produced

**Facts (`src/brief/facts.ts`)**
- `OpenProblem` gains:
  - `command: string | null`: the normalized command;
  - `isTest: boolean`: one of the problem's failures is a `test_failed`.
- `LooseEnds` gains `gitUnavailable: boolean`.
- `problemText(p)`: `` `<command>` — <error> ``, or `<error>`. Used by every renderer, the standup and loose ends.
- `contradictionOf(p)`: `<problemText> (still failing)`. This is the one place the contradiction string is built, so renderers can match a contradiction back to its problem.
- `editedPaths(events, root)` and `shortList(items)` (`a, b, c and 2 more`).

**Git**
- `WorkingState.unavailable?: true`: git ran but failed or timed out. Not set for "not a repo" or "git not installed".

**Renderers**
- `splitProblems(f) → { claimed: { text, attempts }[]; open: OpenProblem[] }`
- `fit(prefix, text, width = 100)` (cuts by code point)
- `painter(color)` is now exported.
- `buildStandup(input, opts = { prefix: false }): Standup`
- `renderStandup(s): string`
- `renderLooseEnds(items, now, { color }): string`

**Brief**
- `buildLooseEnds({ repo, config, now, readWorking, deadline? }): LooseEnds[]`

**Commands**
- `runStandup({ cwd, since?, all, copy })`
- `defaultSince(now)`
- `copyToClipboard(text) → '(copied)' | '(clipboard tool not found)'`
- `runLoops({ json })`

**CLI**
- `leftoff standup [--since <when>] [--all] [--copy]`
- `leftoff loops [--json]`
- `leftoff` with no arguments is the same as `leftoff loops`.

## 4. How it works

### Part A

```ts
export const problemText = (p: OpenProblem): string =>
  p.command !== null ? `\`${p.command}\` — ${p.error}` : p.error;
export const contradictionOf = (p: OpenProblem): string => `${problemText(p)} (still failing)`;
```

- **`error` when there is no output:** a failed command with no output used to show its event summary (`` `npx …` failed: exit code 130 ``). With the command already in front, it now shows `exit code 130`. A shell failure reads `` `make deploy` — exit code 2 ``.
- **Next step:** `Verify` looks up the problem behind the first contradiction:
  - with a command: `` Verify: `cmd` still failing ``;
  - otherwise the contradiction as before, e.g. `Verify: 3 uncommitted files`.
- **Dedupe:** `splitProblems` matches each contradiction to its problem with `contradictionOf`. The terminal and Markdown renderers show matched problems (with their `tried:`) under "Agent said done, but" and the rest under "Open problems".
- **Cap:** `fit(prefix, text)` counts code points, so emoji aren't split. It's applied to the header, every bullet, `✗` and `tried:` line, the claim quote and the next step. Not cut:
  - the polished paragraph (prose; Task 12 can wrap it);
  - the Sources line (always short).

  Color is added after cutting, so plain = colored minus ANSI still holds (tested with long lines).

### Standup

```
since = --since ? parseSince(…) : defaultSince(now)      // Mon → Friday 00:00, else yesterday 00:00
ingest (1200 ms; project-filtered unless --all; a failure is logged)
projects = cwd project | --all: every project with events since `since`, most recent first
facts per project (stored events + live git)
Yesterday  commits since `since`
           else "Worked on <files> with <agents>"   (edits; B4)
           else "Worked on: <newest agent prompt>"  (your choice)
           else "Worked in <project> with <tools>"
Today      each project's next step
Blockers   each project's open problems (problem text)
```

- Empty sections render as `Today: none` and `Blockers: none`.
- With no Yesterday items: `- No activity recorded in this period`.
- `--copy` runs `pbcopy`, `wl-copy`, `xclip -selection clipboard` in turn. The first tool that exits 0 wins; a tool that's installed but fails (e.g. `pbcopy` over SSH) falls through to the next.

### Loose ends

```
projects with events in the last retentionDays, most recent first, at most looseEnds.maxProjects
  per project: git status (unless past the deadline → unavailable), buildFacts
  keep it if: claimedDone · open problem · uncommitted files · git unavailable
  stale = uncommitted files and last activity ≥ staleDays ago
sort: claimedDone, more open problems, stale, oldest activity
```

**`runLoops`:**
- ingest, with a 1200 ms budget;
- `deadline = start + 1500 ms`: once it passes, git isn't read for the remaining projects, and they show `? git status unavailable` rather than being dropped;
- a git timeout or failure for one project gives the same line.

**Render:** the `!` line follows your wording rule.

```ts
// tests among the matched problems, the rest "other problems"; unmatched contradictions
// (the "N uncommitted files" one) are appended after " · "
"1 test still failing" | "2 problems still failing" | "1 test and 1 other problem still failing"
```

- Lines are cut from the middle: the quoted message or the problem text is shortened, and the trailing `" — 1 test still failing` and ` (2 attempts)` are always kept.

## 5. Design decisions

| Decision | Alternatives | Why |
|---|---|---|
| `OpenProblem.command` + `problemText()` used everywhere | Bake the command into `error` | `--json` keeps the raw error and command separately; one function builds the display text |
| Contradictions built by `contradictionOf` | Match strings ad hoc | Dedupe and `Verify` must find the problem behind a contradiction exactly |
| Agent context and `--json` keep every problem | Dedupe there too | Your choice: a new session must see each problem's "Already tried" |
| Commands shown as run (`npm run lint 2>&1`) | Strip redirections | Not asked; changing it would also change which successful run resolves a failure (§9) |
| Polished paragraph not cut at 100 | Cut it | It's up to 1200 characters of prose; cutting would destroy it |
| Standup not cut at 100 | Cut it | It's meant to be pasted (`--copy`); "…" would lose text |
| Blockers and Today use the problem text | Error only (plan literal) | Consistent with your Resolve choice; the plan literal is updated |
| `Today: none` when empty | Omit, or invent a line | Mirrors §1.8's `Blockers: none` |
| Standup ingests first | Stored data only | Same as `resume`; otherwise the morning standup misses the last terminal commands |
| Weekend `since` = the previous day | Friday | The plan only makes Monday special |
| `buildStandup(input, { prefix })` | Prefix in `runStandup` | The flat lists lose the project, so prefixing has to happen while building |
| `WorkingState.unavailable` only for git failures | For any empty result | A plain folder (not a repo) isn't a loose end |
| `deadline` in `buildLooseEnds` | Per-call timeouts only | `gitSync` is synchronous; the deadline guarantees the 1500 ms total |
| Loose-ends layout: header, blank line, projects, blank line, last line | No blank lines | Matches the brief's block style; §1.8's example only showed the project lines |
| Golden keeps §1.8's lines and adds a `✗` line for the failing test | Exactly §1.8 | With "list every problem", the test behind the `!` line must have its own `✗` line; §1.8 updated to the golden |
| Spawn `node src/cli/index.ts` for the bare-command test | Build first, or refactor `index.ts` | Tests real wiring; Node strips types on every CI version (22 latest, 24, 26) |

## 6. Tests

### 6.1 Real-fixture briefs, re-rendered

Same method as Task 10 §6.1:
- the built CLI (`node dist/cli.js`);
- ingest from temp copies of `tests/fixtures/{claude,codex}/session-basic.jsonl`;
- live git state from your untouched scratch folders;
- `NO_COLOR=1`, about 14 hours after the sessions.

**Claude Code session.** Before (Task 10):

```
Agent said done, but
  claude said: "All tests pass, done." (14h ago)
  ✗ npm error npx canceled due to missing packages and no YES option: ["eslint@10.13.0"] (still failing)
  ✗ npm error Missing script: "lint" (still failing)
Done …
Unfinished
  • calc.js (untracked, uncommitted)  …
Open problems
  ✗ npm error npx canceled due to missing packages and no YES option: ["eslint@10.13.0"]
  ✗ npm error Missing script: "lint"
Next step
  → Verify: npm error npx canceled due to missing packages and no YES option: ["eslint@10.13.0"] (still failing)
```

After:

```
$ leftoff resume --project /private/tmp/leftoff-fixture
Where you left off — leftoff-fixture (main) · last active 14h ago

Agent said done, but
  claude said: "All tests pass, done." (14h ago)
  ✗ `npx --no-install eslint . 2>&1` — npm error npx canceled due to missing packages and no YES op…
  ✗ `npm run lint 2>&1` — npm error Missing script: "lint" (still failing)

Done
  • Edited 1 file: calc.js

Unfinished
  • calc.js (untracked)
  • calc.test.js (untracked)
  • package.json (untracked)

Next step
  → Verify: `npx --no-install eslint . 2>&1` still failing

Sources: claude ✓  git ✓  shell ✓  codex ✓
```

**Codex session:**

```
$ leftoff resume --project /private/tmp/leftoff-codex-fixture
Where you left off — leftoff-codex-fixture (main) · last active 14h ago

Agent said done, but
  codex said: "All tests pass, done." (14h ago)
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

**With a `next:` note:**

```
$ cd /private/tmp/leftoff-fixture && leftoff note "next: add a lint script to package.json" && leftoff resume | tail -9
Noted.
  • package.json (untracked)

Notes
  • next: add a lint script to package.json

Next step
  → add a lint script to package.json

Sources: claude ✓  git ✓  shell ✓  codex ✓
```

**`--md`, Codex session** (dedupe applies; no cap):

```
### Agent said done, but

codex said: "All tests pass, done." (14h ago)

- ✗ `npx --no-install eslint .` — exit code 130 (still failing)
- ✗ `npm run lint` — npm error Missing script: "lint" (still failing)

### Unfinished

- `calc.js` (untracked)
…
### Next step

→ Verify: `npx --no-install eslint .` still failing
```

What changed:
- **"Open problems" is gone from both briefs:** every open problem is already a contradiction.
- **Commands lead each line.**
- **"untracked" only.**
- **The 100-character cap** cuts the npx line; that line loses its "(still failing)" suffix (§9.1).
- **Commands are shown as run.** Claude ran `npm run lint 2>&1`, so the brief shows that (§9.2).

### 6.2 The new commands on the same real data

```
$ leftoff
Loose ends across 2 projects

leftoff-fixture (main) · 14h ago
  ! Agent said "All tests pass, done." — 2 problems still failing
  ✗ `npx --no-install eslint . 2>&1` — npm error npx canceled due to missing packages and no YES op…
  ✗ `npm run lint 2>&1` — npm error Missing script: "lint"
  • 3 uncommitted files
leftoff-codex-fixture (main) · 14h ago
  ! Agent said "All tests pass, done." — 2 problems still failing
  ✗ `npx --no-install eslint .` — exit code 130
  ✗ `npm run lint` — npm error Missing script: "lint"
  • 3 uncommitted files

Run `leftoff resume` inside a project for details
```

- **Speed:** 491 ms on the first run (including ingest), 239 ms on the second. The §1.12 target is under 1.5 s.
- **"2 problems", not "tests":** the failing test run was resolved by the passing re-run, so neither remaining problem is a test.

```
$ cd /private/tmp/leftoff-fixture && leftoff standup --since 2026-10-26
Yesterday:
- Worked on calc.js with claude
Today:
- Verify: `npx --no-install eslint . 2>&1` still failing
Blockers:
- `npx --no-install eslint . 2>&1` — npm error npx canceled due to missing packages and no YES option: ["eslint@10.13.0"]
- `npm run lint 2>&1` — npm error Missing script: "lint"

$ leftoff standup --all --since 2026-10-26
Yesterday:
- leftoff-codex-fixture: Worked on calc.js with codex
- leftoff-fixture: Worked on calc.js with claude
Today:
- leftoff-codex-fixture: Verify: `npx --no-install eslint .` still failing
- leftoff-fixture: Verify: `npx --no-install eslint . 2>&1` still failing
Blockers:
- leftoff-codex-fixture: `npx --no-install eslint .` — exit code 130
- leftoff-codex-fixture: `npm run lint` — npm error Missing script: "lint"
- leftoff-fixture: `npx --no-install eslint . 2>&1` — npm error npx canceled due to missing packages and no YES option: ["eslint@10.13.0"]
- leftoff-fixture: `npm run lint 2>&1` — npm error Missing script: "lint"

$ leftoff standup --since "last week"
leftoff: unrecognized --since "last week" (use yesterday, today, Nh or YYYY-MM-DD)      (exit 1)
```

The default `since` today (Tuesday 2026-10-27) is Monday 00:00 local, so it showed the same Yesterday line.

### 6.3 RED

- **Part A:** 22 failing after the test changes, before any code. Among them:
  - golden `rahul.txt`;
  - "Agent said done, but" / dedupe / other problems stay / 100-character cap;
  - Markdown sections and dedupe;
  - `problemText` (not yet exported);
  - exit-code fallback, tool error without a command;
  - Verify/Resolve with a command;
  - Rahul `nextStep`;
  - both real-fixture fact tests;
  - two `resume` tests;
  - two agent-context tests.
- **Part B:**
  - `Cannot find module` for `src/render/standup.ts`, `src/cli/commands/standup.ts`, `src/brief/loose-ends.ts`, `src/render/loose-ends.ts` and `src/cli/commands/loops.ts`;
  - plus 2 assertion failures:
    - `isTest`: expected `[ 'npm run lint', undefined ]` to equal `[ 'npm run lint', false ]`;
    - corrupt index: expected `{ … (3 keys) }` to equal `{ … unavailable: true }`.

**Failures during GREEN:**
- **Two expectations used the plan's wording, not the real data.** Claude's real commands carry `2>&1` (`npm run lint 2>&1`), and a shell failure now reads `` `make deploy` — exit code 2 `` instead of `` `make deploy` exited 2 ``. Both are the correct new output, so I changed the expectations.
- **`findLast`** isn't in the ES2022 lib (`tsc`). I used `[...events].reverse().find`, the idiom already in `facts.ts`.
- **`tsc`:** four test literals lacked the new `isTest` field.

### 6.4 Mutation checks (code broken on purpose, then restored)

| Break | Caught by |
|---|---|
| No dedupe | 3 tests (terminal ×2, Markdown) |
| `tried:` not moved | 2 tests |
| No 100-character cap / cap off by one | `lines longer than 100 characters …` |
| `Verify` without the command | `a contradiction from a failing command …` |
| No exit-code fallback | 2 tests, including the real Codex fixture |
| Loose-ends order ignores claimedDone | ordering test |
| Loose-ends order ignores stale | **survived at first**: the stale project was also the oldest. Added a git-unavailable project that is older but not stale → caught |
| No `maxProjects` / stale off by one / unavailable dropped / no deadline | 1–2 tests each |
| Git failure not marked unavailable | corrupt-index test |
| Tests not detected on the `!` line | golden + counts test |
| `stale` not shown | golden |
| Cut ignores the trailing counts | long-lines test |
| "Worked on" added despite commits | 3 tests |
| No "Worked on: <last request>" | its test |
| No `--all` prefix | 2 tests |
| Monday not special | `Monday since covers Friday` |
| `xclip` without `-selection clipboard` / a failing tool counted as copied | clipboard-order test |
| Bare `leftoff` not wired | `bare \`leftoff\` runs loops` |

### 6.5 Tests

**Part A (+9):**
- **`facts`:** command on the problem (env prefix removed); `exit code 130`; tool error without a command.
- **`next-step`:** Verify and Resolve with a command.
- **`terminal`:**
  - dedupe;
  - other problems stay;
  - 100-character cap (ASCII, emoji, `tried:`, color = plain);
  - the "Agent said done, but" test now includes the moved `tried:` line.
- **`markdown`:** dedupe with `tried:`.
- **Updated tests:** golden, Markdown sections, agent context, `resume`, real fixtures, and the claimed-done strings.

**Part B (+41):**
- **`render/standup` (9):**
  - Rahul *(plan)*;
  - "Worked on <files> with <agent>" *(plan)*;
  - "and N more";
  - B4: no "Worked on" with commits;
  - "Worked on: <last request>";
  - "Worked in …";
  - no activity *(plan)*;
  - `--all` prefix *(plan)*;
  - other projects ignored.
- **`cli/standup` (9):**
  - default `since` (Wednesday, Friday 00:00, Sunday, in UTC+05:30);
  - Monday covers Friday *(plan)*;
  - cwd project with `--since`;
  - work before `--since` excluded;
  - `--all` across projects;
  - invalid `--since`;
  - `--copy` with a fake `pbcopy` on `PATH`;
  - tool order with arguments (`pbcopy` failing → `xclip -selection clipboard`);
  - no tool found.
- **`brief/loose-ends` (8):**
  - ordering *(plan)*;
  - entry fields;
  - stale boundary and config;
  - clean projects omitted *(plan)*;
  - `maxProjects` *(plan)*, and only those projects' git is read;
  - `retentionDays`;
  - git unavailable kept;
  - deadline.
- **`render/loose-ends` (9):**
  - golden *(plan)*;
  - "No loose ends." *(plan)*;
  - "1 project";
  - the `!` wording (7 cases, including mixed and uncommitted);
  - every problem listed;
  - no attempts / no branch;
  - `? git status unavailable`;
  - long lines keep their counts;
  - color = plain.
- **`cli/loops` (4):**
  - terminal output on a real git repo;
  - `--json`;
  - nothing tracked;
  - bare `leftoff` *(plan)*, the same as `loops`, plus `loops --json`. These spawn the real CLI.
- **`facts`:** `isTest`.
- **`git`:** corrupt index → unavailable; a plain folder → not unavailable.

**Final run** (`npm run check`):

```
> tsc --noEmit && eslint . && prettier --check . && vitest run --project unit
 Test Files  35 passed (35)
      Tests  537 passed | 1 skipped (538)
```

538 = 488 (Task 10) + 9 (Part A) + 41 (Task 11). The skipped test is the fish raw-tab test, by design.

## 7. Edge cases and failure handling

| Situation | Behavior |
|---|---|
| Failed command with no output | `` `cmd` — exit code N `` |
| Contradiction that is not a command (`3 uncommitted files`) | `Verify: 3 uncommitted files`; on the `!` line after ` · ` |
| Line over 100 characters (terminal) | Cut with `…`; loose ends keep the quote's end and the counts; emoji are not split |
| Standup with no activity | `- No activity recorded in this period`, `Today: none`, `Blockers: none` |
| Standup project with only prompts, or only commands | `Worked on: <last request>`, or `Worked in <project> with <tools>` (notes and git excluded) |
| Invalid `--since` | `leftoff: unrecognized --since …` with the accepted forms, exit 1 |
| `--copy` with a tool that is installed but fails | The next tool is tried; none left → `(clipboard tool not found)` |
| Ingest fails (standup or loops) | Logged; output from stored data |
| Git fails or times out for one project | Shown with `? git status unavailable`, not dropped |
| 1500 ms budget used up | Remaining projects skip git and show the same line |
| Plain folder (not a repo) | Not a loose end on that basis |
| Nothing tracked, or everything clean | `No loose ends. Everything is committed and passing.` |
| Output piped / `NO_COLOR` | No color (loops, like resume) |

## 8. Deviations from the plan

All of these are your decisions, or follow directly from them:

1. **Part A:**
   - `OpenProblem.command`;
   - `problemText` everywhere;
   - `Verify` and `Resolve` forms;
   - dedupe in terminal and Markdown;
   - 100-character terminal cap;
   - single file status;
   - §1.1, §1.12 and the golden file updated.
2. **`OpenProblem.isTest`**, for the `!` line wording you chose.
3. **The §1.8 loose-ends example gains a `✗` line for the failing test** ("list every problem"), plus blank lines around the projects (§5).
4. **The plan's Rahul standup literal** now shows the problem text in Today and Blockers.

Additions the plan's interfaces didn't have:

5. `buildStandup`'s second argument `{ prefix }`.
6. `buildLooseEnds`'s optional `deadline`.
7. `WorkingState.unavailable` and `LooseEnds.gitUnavailable`, needed to show `? git status unavailable`.
8. `runStandup` ingests first.

## 9. Open questions and risks

1. **The cap can hide "(still failing)".** In the Claude brief, the npx contradiction is cut before its suffix. Inside "Agent said done, but", every line is still failing, so the suffix is redundant there. Options:
   - (a) leave it;
   - (b) drop "(still failing)" in that section of the terminal brief only;
   - (c) cut the middle of the error so the suffix stays, as loose ends already does.

   I lean (c) for consistency with loose ends.
2. **`2>&1` and other redirections are part of the command.** The brief shows `npm run lint 2>&1`. Also, a later successful `npm run lint` does **not** resolve a failed `npm run lint 2>&1`, because normalization keeps the redirection. Stripping trailing `2>&1` / `>/dev/null` in `normalizeCommand` would make both read better and resolve correctly. It changes §1.7's normalization rule, so it's your call.
3. **Standup Blockers can be long.** The Claude standup's npx blocker is 120 characters (no cap, by design, for pasting). Fine for Slack. Say if you'd rather cap the standup too.
4. **The Task 10 §9.3 probe-count `doctor` line** is still open (Task 15).

## 10. Commit

`67ff785` — `feat(cli): standup and loose-ends commands` (filled in by Task 12's commit, B11).
