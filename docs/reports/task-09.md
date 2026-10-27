# Task 09: Work sessions and brief facts

This commit has three parts:

- **A.** The **soft deadline** you approved after Task 8.
- **B.** A **redaction performance bug** found by part A's tests.
- **C.** Task 9 itself.

## 1. Goal

**Task 9 (plan):** turn stored events and the live git state into deterministic `BriefFacts` (§1.7):
- work sessions split at a 45-minute gap (P6);
- the window (last session, plus the previous one if the last has fewer than 3 events);
- open problems with attempts;
- "claimed done" with contradictions (R-D1);
- next step (first match wins);
- `factsHash`.

These must have no false alarms for the Review Focus 6 messages.

**Part A (your decision on Task 8 §9.1):**
- `CollectContext.deadline`. Collectors check it between files and chunks, stop starting new work once it has passed, and return what they completed, so partial progress is always committed.
- The hard timeout stays.
- Tests: a backlog larger than one run's budget finishes over several runs, with no duplicates and no lost lines.
- Plan text: background runs use 20 s; `setup` does a 60 s catch-up with a progress line.

## 2. Files

| File | Purpose |
|---|---|
| `src/brief/sessions.ts` | **New:** `splitSessions` |
| `src/brief/facts.ts` | **New:** `BriefFacts`, `OpenProblem`, `ClaimedDone`, `LooseEnds` types; `findOpenProblems`, `detectClaimedDone`, `buildFacts` |
| `src/brief/next-step.ts` | **New:** `chooseNextStep` |
| `src/brief/hash.ts` | **New:** `factsHash` |
| `src/collectors/types.ts` | **A:** `CollectContext.deadline`, `pastDeadline(ctx)` |
| `src/collectors/jsonl-reader.ts` | **A:** `readJsonlFrom(…, deadline)` stops between 1 MiB chunks; `readZstJsonl(…, deadline)` stops between 1000-line batches and returns `complete` |
| `src/collectors/claude.ts`, `codex.ts`, `shell.ts`, `git.ts` | **A:** stop between units, least recently read first (`readAt` / `checkedAt` in cursors); shell events now carry `data.command` |
| `src/ingest/ingest.ts` | **A:** gives each collector `deadline = start + 60% of its slice` |
| `src/model/redact.ts` | **B:** the `NAME=value` rule starts only at a word start (it was quadratic) |
| `tests/brief/{sessions,next-step,facts}.test.ts` | **New:** 4 + 9 + 36 tests |
| `tests/brief/rahul.ts` | **New:** the §1.1 scenario as events, `RAHUL_WORKING`, `RAHUL_REPORT`, `RAHUL_NOW` (reused by Tasks 10, 11, 16) |
| `tests/collectors/*.test.ts`, `tests/ingest/ingest.test.ts` | **A:** 12 soft-deadline and rotation tests; shell `data.command` expectations |
| `tests/model/redact.test.ts` | **B:** 3 speed tests (100 KB in < 50 ms) |
| `docs/leftoff-implementation-plan.md` | **A/B:** `CollectContext.deadline`, the soft-deadline contract in Task 8, 20 s background budgets (Tasks 12, 14), the 60 s `setup` catch-up plus its test (Task 15), the redaction note (Task 3) |
| `docs/reports/task-09.md` | This report |
| `docs/reports/task-08.md` | §10 backfilled |
| `docs/PROGRESS.md` | Task 8 hash; Task 9 entry |

## 3. Interfaces produced

**`src/brief/`** (used by Task 10 renderers and `resume`, Task 11 standup and loose ends, Task 12 polish, Task 13 the session-start hook, Task 14 the auto brief)
- `splitSessions(events: WorkEvent[], gapMinutes: number): WorkEvent[][]`: events sorted by time; a new session starts when the gap to the previous event is ≥ `gapMinutes`.
- `buildFacts(root, deps: { repo; config; report: IngestReport | null; working: WorkingState | null; now }): BriefFacts`: never throws on empty data. With `report: null`, it uses the last stored ingest report (`cursors('ingest','last_report')`), which is what `brief --auto` needs, since it doesn't ingest.
- `findOpenProblems(events): OpenProblem[]`: newest first.
- `detectClaimedDone(events, openProblems, uncommittedCount): ClaimedDone | null`
- `chooseNextStep(f: Omit<BriefFacts, 'nextStep'>): string | null`
- `factsHash(f: BriefFacts): string`: sha1 hex, excluding `lastActiveAt` and `sources`.
- Types exactly as in §1.7: `BriefFacts`, `OpenProblem`, `ClaimedDone`, `LooseEnds` (`LooseEnds` is used in Task 11).

**Part A**
- `CollectContext.deadline?: number` (epoch ms) and `pastDeadline(ctx): boolean`.
- `readJsonlFrom(file, offset, maxBytes, deadline?)`; `readZstJsonl(file, skipLines, deadline?)`, which now also returns `complete: boolean`.

## 4. How it works

### Part A: soft deadline

```ts
// ingest: each collector gets a soft deadline inside its hard slice
const ctx = { ...base, deadline: Date.now() + budgetMs * SOFT_DEADLINE_FRACTION };   // 0.6
result = await withBudget(collector.collect(ctx), budgetMs);                          // hard limit unchanged
```

```ts
// collectors (claude shown; codex, shell, git alike)
const queue = files.sorted by cursor.readAt ascending;     // least recently read first
let didWork = false;
for (const { file, cursor } of queue) {
  if (size === cursor.offset) continue;                     // nothing new: not a unit of work
  if (didWork && pastDeadline(ctx)) break;                  // keep what's done
  didWork = true;
  const read = await readJsonlFrom(file, cursor.offset, maxBytes, ctx.deadline);   // stops between 1 MiB chunks
  …events + cursor { offset, toolUses, readAt: now }
}
```

- **Units:** Claude, Codex and shell files; git projects; inside a file, 1 MiB chunks (JSONL) or 1000-line batches (zst). The first unit is always finished, so every run makes progress.
- **What isn't reached keeps its cursor.** The shell collector explicitly carries the committed offsets of files it didn't reach. A partly read `.zst` is saved with `size/mtimeMs = -1` and `lines = consumed`, so the next run continues from there.
- **Rotation:** without it, a session that grows every run (an active Claude session) would be served first every time and the backlog would starve. Each cursor records `readAt` (`checkedAt` for git), and the least recently read goes first.
- **Hard timeout:** still `withBudget(slice)`. With the soft deadline at 60%, the remaining 40% is headroom for the unit in progress.

### Part B: the redaction slowdown

The soft-deadline test with a 3 MB transcript took **5 s for 3000 events**. Profiling isolated it: `makeEvent` took 1.6 ms per 1 KB summary, and per-rule timing found **one** rule, `NAME=value` (1137 ms on a 20 KB word; every other rule ≤ 1 ms).

The cause: `/([A-Za-z_][A-Za-z0-9_.-]*)=…/` can start at every letter of a long word, scan to the end looking for `=`, and back off. That's quadratic: a single 100 KB word took **16 s**. Real agent messages and command outputs contain long words (paths, base64, minified code).

Fix: a name may only start where no name character precedes it, and leading dashes are part of the name:

```ts
/(?<![A-Za-z0-9_.-])(-{0,2}[A-Za-z_][A-Za-z0-9_.-]*)=("[^"]*"|'[^']*'|[^\s"'&]+)/g
```

`--token=abc` is still redacted: the name `--token` starts at the first dash. All 78 earlier redaction tests pass unchanged. The result:
- 100 KB inputs now take 1–3 ms (the tests allow < 50 ms);
- `makeEvent` on 3000 × 1 KB summaries went from **4857 ms to 62 ms**.

### Task 9: open problems

```ts
function problemGroups(events) {
  events.forEach((e, index) => {
    if (FAILURES.has(e.kind)) group[key(e)].push(e);       // key: normalized data.command, else kind+tool+summary
    else if (e.kind === 'command' && command !== null) delete group['cmd:' + command];   // a later success resolves
  });
}
```

- **Grouping by normalized command** (`normalizeCommand`: whitespace and leading `VAR=x` removed) means a test run that produced `command_failed` + `test_failed`, or three failed retries, is **one** problem. Rahul's scenario expects exactly one.
- **A failure without a command** (a `tool_error` such as "Read failed") forms its own group; nothing can resolve it (see §9.1).
- **`OpenProblem`:**
  - `firstSeen` = the first unresolved failure;
  - `error` = the first line of the newest `data.error` (otherwise the summary);
  - `source` = the newest failure's source;
  - `attempts` = summaries of the `file_edit` and `command` events after the first failure, deduplicated, the **first** 5 in time order (the plan says "newest last, max 5"; I keep the ones closest to the failure);
  - sorted **newest first**, so `Resolve:` and the auto brief's "top open problem" use `[0]`.
- **Cross-source resolution:** a command the agent failed and you later ran successfully in your shell resolves the problem (same normalized command). That's why shell events now carry `data.command`.

### Task 9: claimed done

```ts
const CLAIM = /\b(done|completed?|finished|fixed|implemented|committed|pushed|merged|all (tests )?pass(ing|ed)?|ready (for review|to merge))\b/i;
const NEGATION = /\b(not|isn't|wasn't|haven't|still)\b.{0,20}\b(done|complete|finished|fixed|passing)\b/i;
const COMMIT_CLAIM = /\b(committed|pushed|merged|ready to merge)\b/i;
```

- **The claim:** the **newest** `agent_message` that matches `CLAIM` and not `NEGATION`.
- **Contradictions:**
  1. Every open problem with a failure **from the same agent session** (any time) or **after the claim** → `"<error> (still failing)"`.
  2. Uncommitted files, **only** if the claim matches `COMMIT_CLAIM` and there's no `commit` event after it → `"N uncommitted file(s)"` (R-D1).
- **`committed|pushed|merged` were added to `CLAIM`.** Without them, the plan's own tests ("Committed the fix", "Pushed to origin", "Merged into main") would never be claims (§8.2).

### Task 9: buildFacts

```ts
const events = repo.eventsForProject(root, now − retentionDays);
const sessions = splitSessions(events, config.sessionGapMinutes);
const window = last.length < 3 && sessions.length > 1 ? [...previous, ...last] : last;
done      = commit subjects in the window, then "Edited N files: a, b, c and K more" (unique paths, relative to the project)
notes     = every note in the retention period (P11: always shown), oldest first
lastIntent / lastAgentMessage = newest user_prompt / agent_message in the window
sources   = report (or the last stored report) in the fixed order claude, git, shell, codex; detail kept when present
nextStep  = chooseNextStep(rest)
```

`chooseNextStep` (§1.7): the newest note starting with `next:` (any case) → `Verify: <first contradiction>` → `Resolve: <newest open problem>` → `Finish and commit changes in <first file>[ and N more]` → `Continue: <lastIntent>` → `null`.

### What the real fixtures produce

Facts built after a real ingest of the two fixtures:

```
/private/tmp/leftoff-fixture (Claude)
  done          Edited 1 file: calc.js
  open problems npm error npx canceled due to missing packages …   (attempts: none)
                npm error Missing script: "lint"
                File does not exist. Note: your current working directory is …   (attempts: Edited calc.js, node --test 2>&1)
                ls: /nope: No such file or directory
  claimed done  "All tests pass, done." → 4 contradictions "(still failing)"
  next step     Verify: npm error npx canceled … (still failing)
/private/tmp/leftoff-codex-fixture (Codex): the same shape, including "`rg --files -g 'notes.md' …` failed: exit code 1"
```

The lint contradictions are fair: the agent said "done" with lint still broken. `ls /nope`, the missing `notes.md` and the `rg` search (exit 1 = "no matches") are exploratory failures, not loose ends. See §9.1.

## 5. Design decisions

| Decision | Alternatives | Why |
|---|---|---|
| Soft deadline at 60% of the slice; the first unit always finished | Plan-only hard timeout | Your decision; every run commits progress |
| Rotation (least recently read first) | Fixed order | Otherwise an always-active session starves the backlog (tested) |
| A file with no new data isn't a unit | Count every file | Otherwise unchanged files use up the guaranteed unit |
| zst partial reads saved with `size = -1` | Separate flag field | The existing "unchanged?" check then simply re-opens it |
| Redaction: name starts only at a word start | Tokenize by whitespace first | One-line change, linear, same results (all tests unchanged) |
| Failures grouped by normalized command | One problem per failure event | Retries and `command_failed` + `test_failed` are one loose end (Rahul expects 1) |
| Shell events carry `data.command` | Parse `summary` | Deterministic; makes shell-vs-agent resolution possible |
| Attempts = first 5 after the failure | Last 5 | The fixes right after a failure belong to it; later commands are more likely unrelated |
| Open problems newest first | Oldest first | `Resolve:` and the auto brief use the newest (§1.7 "newest open problem") |
| "From the same session" includes failures before the claim | Only after the claim | "every open problem from the same agent session or later" (§1.7); an agent claiming done while its own earlier failure is unresolved is exactly the case to flag |
| `committed|pushed|merged` are claims | Keep the §1.7 regex | Needed for R-D1 and its tests |
| Notes from the whole retention period | Only the window | P11 "notes always appear"; a note written yesterday must show today |
| `report: null` → last stored report | All `not_found` | `brief --auto` doesn't ingest but should still show real source statuses |
| Edited-files line: up to 3 names, then "and N more" | All names | Fits the brief's one-line style |
| `factsHash` via `JSON.stringify` with two fields set to `undefined` | Destructuring | Same result; the linter forbids unused variables |

## 6. Tests

**RED:**

```
Part A: 9 tests failed (reader ×2, claude ×2, codex, shell, git, ingest ×2); tsc: Property 'deadline' does not exist on type 'CollectContext'
Part B: × redact is fast on one long word (100 KB in < 50 ms) 15955ms
        × redact is fast on long words with dashes and dots (100 KB in < 50 ms) 12501ms
shell data.command: × maps a successful line to a command event   × exit code != 0 becomes command_failed
Task 9: Error: Cannot find module '../../src/brief/facts.ts' (and next-step.ts, sessions.ts)
```

**Failures during GREEN:**
- **The ingest soft-deadline test:** my first version used 150 ms "files" with a 300 ms budget. After the first file, 150 ms is still before the 180 ms soft deadline, so the fake started a second file and hit the hard limit. With 200 ms files, the test shows what it means to show.
- **The 3 MB transcript test timed out:** this led to part B.

**Mutation checks** (code broken on purpose, then restored):

| Break | Caught by |
|---|---|
| Claude ignores the deadline between files | backlog-over-several-runs test |
| No rotation (Claude / Codex / git) | the rotation tests (Claude, Codex added for this) / one-project-per-run |
| Shell forgets unreached files | **survived at first** (the unreached file had never been read); added the "partly read keeps its offset" test → caught |
| JSONL reader ignores the deadline | 2 tests |
| Partial zst marked complete | **survived at first** (my mutation changed only `size`); with `size` and `mtimeMs` → caught |
| Ingest gives no deadline | 2 ingest tests |
| Success never resolves / commands not normalized | 3 tests / the normalization test |
| Attempts not capped / not deduplicated | `attempts capped at 5 and deduplicated` |
| Problems not newest first | `open problems are newest first` |
| Negations count as claims | the negation tests |
| Any old problem contradicts | `… older open problem from another session does not contradict it` |
| Uncommitted always a contradiction (the pre-R-D1 rule) | `"Done!" with uncommitted files … → null` |
| A later commit ignored | `"Committed the fix" followed by a commit event → null` |
| Previous session never included | `window includes previous session when last has < 3 events` |
| Notes only from the window | `notes always appear …` |
| No stored-report fallback | `without a report, sources come from the last stored ingest report` |
| Commit words not claims | 3 R-D1 tests |
| Session gap `>` instead of `≥` | `splits on 45 min gap` (boundary at exactly 45:00) |
| No "and N more" | `next step: unfinished files` |
| Hash includes `lastActiveAt` | `factsHash ignores lastActiveAt` |

**Tests:**
- `tests/brief/sessions.test.ts` (4):
  - splits on 45 min gap (44:59 same, 45:00 new) *(plan)*;
  - the gap is measured between consecutive events;
  - unsorted input;
  - empty input and decimal gaps.
- `tests/brief/next-step.test.ts` (9):
  - the plan's 6-row table *(plan)*;
  - each rule beats the ones after it;
  - newest `next:` note, case-insensitive;
  - the first (newest) open problem.
- `tests/brief/facts.test.ts` (36):
  - **open problems:**
    - Rahul's problem with `['changed port to 587', 'disabled TLS']` *(plan)*;
    - resolved by a later success *(plan)*;
    - normalized matching;
    - a success *before* the failure doesn't resolve it;
    - repeated failures are one problem;
    - `command_failed` + `test_failed` are one problem;
    - newest first;
    - a tool error stays open;
    - attempts capped and deduplicated *(plan)*.
  - **claimed done:**
    - "All tests pass" then a failure *(plan)*;
    - the same session before the claim;
    - an older problem from another session doesn't count;
    - "Done!" with uncommitted files → null *(R-D1)*;
    - 4 commit-claim phrases → "2 uncommitted files" *(R-D1)*;
    - singular "1 uncommitted file";
    - commit after the claim → null *(R-D1)*;
    - claim, failure, fix, passing re-run → null *(plan)*;
    - 3 negations *(plan)*;
    - "Done reading the file, now editing" → null *(plan)*;
    - no agent message *(plan)*;
    - newest matching message.
  - **buildFacts:**
    - Rahul *(plan: branch, file, `Resolve: SMTP connection refused`, plus done, attempts, window, sources)*;
    - window = the last session only;
    - the previous session is included when the last has < 3 events *(plan)*;
    - the "Edited 4 files: … and 1 more" line;
    - notes always appear and drive `next:`;
    - no events and no git → empty facts *(plan)*;
    - stored-report fallback;
    - error detail kept;
    - `retentionDays` respected.
  - **factsHash:** ignores `lastActiveAt` *(plan)*.
- **Part A (12):**
  - reader chunks ×2;
  - Claude backlog, huge file and rotation;
  - Codex backlog plus big zst, and rotation;
  - shell one-file-per-run and partly read;
  - git one-project-per-run;
  - ingest: deadline inside the slice, and progress where a hard timeout alone would fail.
- **Part B (3):** 100 KB: one long word, dashed and dotted words, prose.

**Final run** (`npm run check`):

```
> tsc --noEmit && eslint . && prettier --check . && vitest run --project unit
 Test Files  22 passed (22)
      Tests  396 passed | 1 skipped (397)
```

397 = 333 (Task 8) + 12 (soft deadline) + 3 (redaction speed) + 49 (brief). The 1 skipped is the fish raw-tab test, by design.

## 7. Edge cases and failure handling

| Situation | Behavior |
|---|---|
| No events / no git / no report | Empty facts, all sources `not_found`, `nextStep` null; no throw |
| Only old events (beyond `retentionDays`) | Ignored, like having none |
| Last session has 1–2 events (e.g. a quick `leftoff note`) | The previous session is included, so open problems aren't lost |
| A command fails in the agent and later succeeds in your shell | Resolved (cross-source) |
| Same command with different env prefixes or spacing | Same problem; resolved by any normalized match |
| Agent says "done" while an older failure from **another** session is open | Not a contradiction |
| Several "done" messages | The newest matching one is the claim |
| Huge backlog | Every ingest run commits progress; rotation reaches every file and project |
| Single huge line or file | Chunked reading stops between chunks; the redaction speed fix keeps long lines linear |
| Corrupt stored report | Treated as no report |

## 8. Deviations from the plan

1. **Soft deadline, rotation and `readZstJsonl`'s `complete` flag**: your decision, now in the plan (Task 4's `CollectContext` and Task 8's contract).
2. **`committed|pushed|merged` added to the claim regex** (§1.7): needed for R-D1 and the plan's own Task 9 tests. Please confirm.
3. **Failures grouped by normalized command**: one open problem per unresolved command, not one per failure event.
4. **Shell events carry `data.command`** (Task 4's data shape was `{ exitCode, durationMs, cwd }`).
5. **Attempts are the first 5 after the failure** (the plan's "newest last, max 5" is ambiguous about which 5).
6. **Redaction fix** in `src/model/redact.ts` (Task 3's module), with speed tests; noted in the plan.

## 9. Open questions and risks

1. **Exploratory failures become open problems and "claimed done" contradictions. This needs your decision before the renderers (Task 10) make it visible.** Real agents constantly run commands that "fail" by design: `rg`/`grep` with no match (exit 1), `ls` or `test -f` on a missing path, a Read of a file that doesn't exist. Under the plan's rule each becomes an open problem that nothing will ever resolve. In both real fixtures, 2 of 4 open problems are of this kind. That's exactly the "developers learn to ignore it" risk of Review Focus 6. Options:
   - **(a) Ignore list:** a failure doesn't count when the command is a search or probe (`rg`, `grep`, `find`, `ls`, `test`, `[`, `which`, `command -v`, `cat`/`head` on a missing file) with exit 1 or 2, or is a non-Bash `tool_error` from a read-only tool (Read, Glob, Grep). Deterministic, in one module like the test-failure patterns.
   - **(b) Persistence:** only count a failure if the same command failed twice, or if file edits followed it (signs someone tried to fix it).
   - **(c) Both.**

   My recommendation is **(a)** now, with (b) as a dogfooding candidate.
2. **`tool_error` without a command can never be resolved** (it has no command to match a success against). With option (a) the common read-only cases disappear; Edit/Write errors would remain, and they're real loose ends.
3. **Please confirm §8.2** (commit words as claims).
4. **"From the same session" can flag an early failure the agent later worked around differently** (e.g. it tried `npm run lint`, then fixed lint another way). That's covered by option (b) and by dogfooding.

## 10. Commit

To be filled in by Task 10's commit (B11). The commit message is `feat(brief): sessions, open problems, claimed-done, next step, facts`.
