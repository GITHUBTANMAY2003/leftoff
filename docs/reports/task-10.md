# Task 10: Renderers, `resume` and `note` commands

This commit has two parts:

- **A.** **Probe classification**: your decision on Task 9 §9.1.
- **B.** Task 10 itself.

§6.1 shows the real terminal briefs that the real Claude and Codex sessions produce.

## 1. Goal

**Task 10 (plan):**
- `renderTerminal` (exact §1.8 / §1.1 copy, `NO_COLOR`);
- `renderAgentContext` (exact first and last lines, ≤ 4000 characters, lists shortened before prose);
- `renderMarkdown` and `renderJson`;
- `relativeAgo` and `parseSince`;
- `runResume`: ingest → working state → facts → cached polish → render → mark shown;
- `runNote`;
- CLI wiring.

The golden file must equal the §1.1 brief.

**Part A:** classify, don't drop.
- Probe and search commands, and read-only agent tools, that fail with exit 1 or 2 are stored with `data.probe = true` and kept in the database.
- They're excluded from open problems and claimed-done contradictions.
- They're never excluded when the output looks like a failed test run, or when the exit code is something else (126, 127, 130, …).
- The list lives in one module.
- The plan now has a weekly probe review in Task 17's checklist.

Also recorded: your confirmation of the three Task 9 choices (§8), now in the plan's §1.7.

## 2. Files

| File | Purpose |
|---|---|
| `src/collectors/probes.ts` | **New (A):** `PROBE_COMMANDS`, `isProbeCommand`, `isProbeFailure`, `isReadOnlyTool` |
| `src/collectors/claude.ts`, `codex.ts`, `shell.ts` | **A:** mark probe failures `data.probe = true` |
| `src/brief/facts.ts` | **A:** probe failures skipped for open problems (and therefore contradictions) |
| `src/core/time.ts` | **New:** `relativeAgo`, `parseSince` |
| `src/render/terminal.ts` | **New:** `renderTerminal` (+ shared `header`, `sourcesLine`) |
| `src/render/markdown.ts` | **New:** `renderMarkdown`, `renderAgentContext` |
| `src/render/json.ts` | **New:** `renderJson` |
| `src/cli/commands/resume.ts` | **New:** `runResume` |
| `src/cli/commands/note.ts` | **New:** `runNote` |
| `src/cli/index.ts` | `resume [--project] [--json\|--md]` and `note <text...>` |
| `tests/collectors/probes.test.ts` | **New:** 40 tests |
| `tests/brief/fixtures.test.ts` | **New:** facts from the real Claude and Codex sessions |
| `tests/core/time.test.ts` | **New:** 18 tests |
| `tests/render/{terminal,agent-context,markdown-json}.test.ts` | **New:** 9 + 4 + 2 tests |
| `tests/render/golden/rahul.txt` | **New:** the §1.1 brief, typed by hand; `diff` against the plan's §1.1 block is empty |
| `tests/render/helpers.ts` | `rahulFacts()` built the real way (events → `buildFacts`) |
| `tests/cli/{resume,note}.test.ts` | **New:** 7 + 5 tests |
| `tests/brief/rahul.ts` | `rahulEvents(projectRoot?)` so CLI tests can use a real temp folder |
| `tests/collectors/{claude,codex,shell}.test.ts`, `tests/brief/facts.test.ts` | **A:** probe tests |
| `docs/leftoff-implementation-plan.md` | **A:** probe rule (§1.7), `probes.ts` in the file tree, weekly probe review (Task 17), claim regex (§1.7), Task 10 notes |
| `docs/reports/task-10.md` | This report |
| `docs/reports/task-09.md` | §10 backfilled |
| `docs/PROGRESS.md` | Task 9 hash; Task 10 entry |

## 3. Interfaces produced

**Part A: `src/collectors/probes.ts`** (used by the three agent/shell collectors; contributors add commands here)
- `PROBE_COMMANDS: string[]`: `ls cat head tail stat test [ which "command -v" type grep rg ag find fd "git show" "git rev-parse" "git ls-files" "git cat-file" diff cmp`.
- `isProbeCommand(command): boolean`: every part of a `&&` / `||` / `;` / `|` line must be a probe; `cd` parts are allowed.
- `isProbeFailure(command, exitCode, output): boolean`: a probe command, exit 1 or 2, and output that doesn't look like a failed test run.
- `isReadOnlyTool(tool): boolean`: `Read`, `Glob`, `Grep`, `LS`.

**`src/core/time.ts`** (used by renderers, Task 11 standup, Task 14 auto brief)
- `relativeAgo(iso, now): string`: `just now` (< 1 min, or in the future), `Nm ago`, `Nh ago`, `Nd ago`.
- `parseSince(s, now): Date`: `today` / `yesterday` (local midnights), `Nh`, `YYYY-MM-DD` (local midnight; impossible dates rejected); otherwise it throws with a hint.

**`src/render/`** (used by `resume`, Task 13 session-start hook, Task 14 auto brief, Task 12 polish prompt context)
- `renderTerminal(f, polished, opts: { color: boolean; now?: Date }): string`
- `renderAgentContext(f, polished, opts?: { now?: Date }): string` (≤ 4000)
- `renderMarkdown(f, polished, opts?: { now?: Date }): string`
- `renderJson(f, polished): string` → `{ facts, polished }`
- `header(f, now)` and `sourcesLine(f, separator, paint?)`: shared helpers (Task 14's auto brief uses `header`).

**`src/cli/commands/`**
- `runResume(opts: { cwd; project?; format: 'terminal' | 'md' | 'json'; polish: boolean }): Promise<{ output: string; exitCode: number }>`
- `runNote(cwd, text): Promise<void>`: it throws on empty text.

**CLI**
- `leftoff resume [--project <path>] [--json | --md]`: `--json` and `--md` conflict.
- `leftoff note <text...>`: prints `Noted.`

## 4. How it works

### Part A: probes

```ts
export function isProbeFailure(command: string, exitCode: number, output: string): boolean {
  return isProbeCommand(command) && PROBE_EXIT_CODES.has(exitCode) && !looksLikeTestFailure(output);
}
```

- **Claude:** a failed Bash result whose command is a probe gets `probe: true`; a `tool_error` from `Read`/`Glob`/`Grep`/`LS` gets `probe: true`.
- **Codex:** a failed `CommandExecution` probe gets `probe: true`. Codex 0.163 has no read-only tools of its own: it reads through shell commands (`ls`, `rg`, `cat`), which the command list covers. That's the "Codex equivalents".
- **Shell:** the shell log has no output, so only the command and exit code decide.
- **Facts:** `problemGroups` skips any failure with `data.probe === true`, so probes are never open problems and never contradictions. They stay in the `events` table for the weekly review.
- **Word boundaries:** commands match on whole words. `catalog-tool` isn't `cat`, `lsof` isn't `ls`, and `git commit` isn't a read-only git subcommand (all tested).

### Terminal brief

```
header                              Where you left off — <name> (<branch>) · last active <ago>
[polished paragraph]                (only if a cached one matches the facts)
Agent said done, but                  <agent> said: "<message>" (<ago>)   then   ✗ <contradiction>
Done                                  • <commit subject> … • Edited N files: …
Unfinished                            • <path> (<status>, uncommitted)
Open problems                         ✗ <error>   then   tried: a · b
Notes                                 • <note>
Next step                             → <next step>
Sources: claude ✓  git ✓  shell ✓  codex –
```

- Blank lines separate blocks, empty sections are omitted, and there's no footer.
- With color: headings bold, ✗ red, ✓ green, → cyan, `tried:` dimmed. Stripping the ANSI codes gives exactly the plain output (tested).
- `resume` uses color only when stdout is a TTY and `NO_COLOR` is unset.

### Agent context (for Task 13)

The structure is `## Previous session in this project (from leftoff)`, then `Project: <name> · branch … · last active …`, the polished text, `Last request:`, the claim with its contradictions, `Done:`, `Uncommitted changes:`, `Open problems (unresolved):` each with **`Already tried (did not fix it): a; b`** (so a new session doesn't retry the same fixes, §1.1), `Notes from the developer:`, `Suggested next step:`, and the exact last line.

**Size:** each list is capped at 20, 10, 5, 3, 1, then 0 items (with `- …and N more`) until the whole text fits in 4000. If even that doesn't fit (a huge single field), the body is cut character by character in UTF-16 units, so the limit holds for emoji too, and the first and last lines are kept.

### resume

```ts
const root = resolveProject(opts.project ?? opts.cwd);
try { report = await ingest({ repo, config, now, projectFilter: root }, { budgetMs: 1200 }); }
catch (err) { logError('resume', err); }               // brief still works from stored data
const facts = buildFacts(root, { repo, config, report, working: readWorkingState(root), now });
if (no activity and nothing uncommitted and not --json) → "No activity recorded yet for <name>. …"
polished = cached && cached.factsHash === factsHash(facts) ? cached.polished : null;
render; if (facts.lastActiveAt) repo.markBriefShown(root, facts.lastActiveAt);
```

### note

`runNote` trims the text (an empty note throws), resolves the project, and inserts `{ source: 'user', kind: 'note', … }` through `makeEvent`, so notes are redacted too (tested: `GH_TOKEN=abc123` → `[REDACTED]`). The dedupe key includes the time, so the same note written twice is kept twice.

## 5. Design decisions

| Decision | Alternatives | Why |
|---|---|---|
| Probes classified at collection time (`data.probe`) | Decide in facts from the command | Your decision ("stored with data.probe = true"); the database shows what was hidden and why |
| A compound line is a probe only if **every** part is | Any part | `ls && npm run build` failing is about the build |
| Probe matching on whole words, with 2-word entries for `git …` and `command -v` | Prefix match | Avoids `lsof`, `catalog-tool`, `git commit` |
| The renderers take an optional `now` | `new Date()` inside | Deterministic goldens and tests; the plan's `opts` had only `color` |
| No diff stat in the terminal brief | Show it under Unfinished | The §1.1 reference doesn't show it; Markdown and agent context do |
| "Agent said done, but" quotes the message and its age, then ✗ lines | Only the contradictions | The developer sees what was claimed and when |
| Agent context labels attempts "Already tried (did not fix it)" | Plain list | The point of handing context to a new session (§1.1: don't retry the two failed fixes) |
| Golden compared with `toBe(readFileSync(…))` | `toMatchFileSnapshot` | A missing snapshot file would be silently created and pass; this way the hand-typed golden is the only truth |
| `resume --json` prints facts even with no activity | The friendly line | Scripts always get JSON |
| `--polish` flag added in Task 12 | A stub flag now | It needs Task 12's providers; until then cached polish is used |
| Color only on a TTY | Always unless `NO_COLOR` | Piped output (`leftoff resume \| pbcopy`) stays clean |

## 6. Tests

### 6.1 The actual terminal briefs from the real sessions

The built CLI, run on the real fixtures. Ingest read from temp copies; the live git state comes from your scratch folders, which were never committed, so every file is untracked. Times are relative to now, about 14 hours after the sessions. Captured from `node dist/cli.js` before this commit:

```
$ leftoff resume --project /private/tmp/leftoff-fixture          # the Claude Code session
Where you left off — leftoff-fixture (main) · last active 14h ago

Agent said done, but
  claude said: "All tests pass, done." (14h ago)
  ✗ npm error npx canceled due to missing packages and no YES option: ["eslint@10.13.0"] (still failing)
  ✗ npm error Missing script: "lint" (still failing)

Done
  • Edited 1 file: calc.js

Unfinished
  • calc.js (untracked, uncommitted)
  • calc.test.js (untracked, uncommitted)
  • package.json (untracked, uncommitted)

Open problems
  ✗ npm error npx canceled due to missing packages and no YES option: ["eslint@10.13.0"]
  ✗ npm error Missing script: "lint"

Next step
  → Verify: npm error npx canceled due to missing packages and no YES option: ["eslint@10.13.0"] (still failing)

Sources: claude ✓  git ✓  shell ✓  codex ✓
```

```
$ leftoff resume --project /private/tmp/leftoff-codex-fixture    # the Codex session
Where you left off — leftoff-codex-fixture (main) · last active 14h ago

Agent said done, but
  codex said: "All tests pass, done." (14h ago)
  ✗ `npx --no-install eslint .` failed: exit code 130 (still failing)
  ✗ npm error Missing script: "lint" (still failing)

Done
  • Edited 1 file: calc.js

Unfinished
  • calc.js (untracked, uncommitted)
  • calc.test.js (untracked, uncommitted)
  • package.json (untracked, uncommitted)

Open problems
  ✗ `npx --no-install eslint .` failed: exit code 130
  ✗ npm error Missing script: "lint"

Next step
  → Verify: `npx --no-install eslint .` failed: exit code 130 (still failing)

Sources: claude ✓  git ✓  shell ✓  codex ✓
```

```
$ cd /private/tmp/leftoff-fixture && leftoff note "next: add a lint script to package.json" && leftoff resume | tail -9
Noted.
  ✗ npm error Missing script: "lint"

Notes
  • next: add a lint script to package.json

Next step
  → add a lint script to package.json

Sources: claude ✓  git ✓  shell ✓  codex ✓
```

What this shows:
- **Probes:** `ls /nope`, the missing `notes.md` Read, and Codex's empty `rg` search are classified as probes and don't appear. Only lint remains, which was the real loose end.
- **The failing test run** was genuine, but the passing re-run resolved it, so it's correctly not open. That's why your "(the failing test run, lint)" list ends up with lint only.
- **The "done" claim is caught:** both agents said "All tests pass, done." while lint was still failing.
- **A `next:` note** immediately becomes the next step.

**Observations for you** (§9): the long npm error lines, and each contradiction appearing twice (under "Agent said done, but" and again under "Open problems").

### 6.2 RED

```
probes.test.ts            → Error: Cannot find module '../../src/collectors/probes.ts'
probe wiring (6 failing)  → × probe failures are marked … (claude, codex, shell)
                            × probe failures are not open problems … (facts)
                            × Claude session: only lint is open …   × Codex session: lint and the interrupted npx are open …
time.test.ts              → Error: Cannot find module '../../src/core/time.ts'   (see note below)
render tests              → Error: Cannot find module '../../src/render/{terminal,markdown,json}.ts'
emoji limit (added later) → AssertionError: expected 7769 to be less than or equal to 4000
cli tests                 → Error: Cannot find module '../../src/cli/commands/note.ts'
```

**Note on `time.ts`:** I wrote it in the same step as its tests. To show red honestly, I moved the module away and ran the tests: "Cannot find module". The other Task 10 modules were written after their failing tests.

**Failures during GREEN:**
- **Agent-context cut:** `renderAgentContext`'s last-resort cut counted code points but the limit is in UTF-16 units. A new emoji test failed at 7769 characters; fixed.
- **`resume ingests first`:** I expected `git –`, but git ran fine there (installed; the folder just isn't a repo), so `git ✓` is correct and the test was wrong.
- **ESLint `no-control-regex`** on three test regexes that match ANSI codes on purpose: suppressed per line, with a reason.

### 6.3 Mutation checks (code broken on purpose, then restored)

| Break | Caught by |
|---|---|
| Empty sections shown | golden + `empty sections are omitted` |
| Notes heading changed | `Notes render after Open problems …` + `note appears in next resume output` |
| Polished text not shown | 2 tests |
| Agent-context lists never shortened | **survived at first** (the last-resort path still produced a valid result, with no file names); the test now requires a file name and the next step to survive → caught |
| Attempts not labeled "Already tried" | `the agent is told what was already tried …` |
| Stale polish shown | `a cached polished summary is shown only while its facts hash still matches` |
| Brief not marked shown | `resume records that the brief was shown …` |
| No ingest before the brief | `resume ingests first …` |
| Empty notes accepted | `an empty note is refused` |
| Any exit code counts as a probe | `"ls /nope" exiting 127 still counts`, `"rg needle" exiting 130 still counts` |
| Test failures hidden as probes | `a probe whose output looks like a failed test run still counts` |
| One probe part is enough | `"ls && npm run build" exiting 1 still counts` |
| Probes counted as open problems | 3 tests, including both real-fixture tests |

### 6.4 Tests

- **`probes.test.ts` (40):**
  - 27 probe failures (every listed command, `grep -q`, compound lines, `cd`, env prefix);
  - 9 that still count: `npm test`, `ls` exit 127, `grep` 126, `rg` 130, `git rev-parse` 128, `ls && npm run build`, `git commit`, `catalog-tool`, `lsof`;
  - test-failure output beats probe;
  - read-only tools;
  - env/whitespace;
  - the list itself.
- **Collectors:** Claude (ls /nope and Read are probes; node --test, lint, npx are not), Codex (ls /nope and rg are probes; node --test, lint, npx exit 130 are not), shell (`ls /nope` exit 1 is a probe, exit 127 is not).
- **Facts:** probes aren't problems or contradictions but stay in events. Real fixtures (2): Claude → only the two lint problems, probes = `ls /nope`, `Read`; Codex → `npx` exit 130 and lint, probes = `ls /nope`, `rg …`.
- **`time.test.ts` (18):** 9 `relativeAgo` boundaries (including `14h ago` from §1.1 and future times); `parseSince` `today`/`yesterday`, `Nh` and `YYYY-MM-DD` in UTC+05:30 (local ≠ UTC midnight); 6 rejected inputs (including `2026-02-30`).
- **`terminal.test.ts` (9):**
  - **golden equals §1.1** *(plan)*;
  - empty sections omitted *(plan)*;
  - "Agent said done, but" first, with each contradiction *(plan)*;
  - Notes position;
  - Sources order and no footer;
  - polished above the facts;
  - header without a branch or activity;
  - `NO_COLOR`/color *(plan)*;
  - color equals plain once ANSI is stripped.
- **`agent-context.test.ts` (4):**
  - exact lines, ≤ 4000 with 200 files, shortened not dropped *(plan)*;
  - "Already tried";
  - huge text fields;
  - the emoji/UTF-16 limit.
- **`markdown-json.test.ts` (2):** JSON is valid with facts and polished *(plan)*; Markdown sections.
- **`resume.test.ts` (7):**
  - no data → friendly line, exit 0 *(plan)*;
  - the brief for the cwd project;
  - `--project`, `--json`, `--md`;
  - ingests first (a shell failure shows up);
  - marks shown;
  - cached polish only on a matching hash;
  - **note appears in the next resume** *(plan)*.
- **`note.test.ts` (5):** stored as a `user` `note`; resolved from a subfolder; duplicates kept; redacted; empty refused.

**Final run** (`npm run check`):

```
> tsc --noEmit && eslint . && prettier --check . && vitest run --project unit
 Test Files  30 passed (30)
      Tests  487 passed | 1 skipped (488)
```

488 = 397 (Task 9) + 40 (probes) + 3 (collector probe tests) + 1 (facts probe) + 2 (real-fixture facts) + 18 (time) + 15 (render) + 7 (resume) + 5 (note). The 1 skipped is the fish raw-tab test, by design.

## 7. Edge cases and failure handling

| Situation | Behavior |
|---|---|
| `resume` in a folder with no history | `No activity recorded yet for <name>. …`, exit 0 (JSON still prints facts) |
| Uncommitted files but no events yet | The brief is shown (Unfinished, next step) |
| Ingest throws (database busy, collector bug) | Logged; the brief uses stored events |
| The database itself can't open | `runResume` throws; the CLI prints `leftoff: <message>` and exits 1 (global handler) |
| Output piped / not a TTY | No color |
| `NO_COLOR` set | No color |
| Cached polish for older facts | Not shown (hash mismatch) |
| Very long text in the agent context | Lists shortened, then cut by UTF-16 length; first and last lines always intact |
| Empty / whitespace note | Refused with an error |
| Secret in a note | Redacted |
| Probe with exit 127 / 130 / 126 / 128 | Still a real failure |
| Probe whose output shows a failed test | Still a real failure |

## 8. Deviations from the plan

1. **Renderers take an optional `opts.now`** (the plan's `renderTerminal` options had only `color`).
2. **`--polish` is not wired yet:** it needs Task 12's `polishNow`. `runResume` keeps the `polish` option for that.
3. **Golden test uses `readFileSync` + `toBe`** instead of `toMatchFileSnapshot` (§5).
4. **Part A additions:** `data.probe`, `src/collectors/probes.ts`, and the plan text for both, all per your decision.

## 9. Open questions and risks

1. **Contradictions repeat the open problems.** In both real briefs, every "Agent said done, but" line also appears under "Open problems". Options:
   - **(a)** keep both (§1.8 as written);
   - **(b)** when a problem is already shown as a contradiction, leave it out of "Open problems";
   - **(c)** keep "Open problems" but shorten the contradiction to a count ("but 2 problems are still failing").

   I lean toward (b), but it changes §1.8's layout, so it's your call. Dogfooding may answer it too.
2. **Long error lines** (npm's `npx canceled due to missing packages and no YES option: ["eslint@10.13.0"]`) make the brief wide. A display cap (e.g. 100 characters with `…`) in the terminal renderer would help; the full text stays in JSON and Markdown. Not in §1.8, so not done.
3. **Probe review:** the weekly SQL query is in Task 17's checklist (plan). Worth also surfacing as a `doctor` info line ("N probe failures hidden in the last 7 days") in Task 15? Not in the plan.

## 10. Commit

To be filled in by Task 11's commit (B11). The commit message is `feat(cli): renderers, resume and note commands`.
