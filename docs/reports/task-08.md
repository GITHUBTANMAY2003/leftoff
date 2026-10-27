# Task 08: Ingest orchestrator

## 1. Goal

From the plan (Task 8):
- **`collectors(config)`:** the enabled collectors in the order claude, codex, shell, git.
- **`ingest(ctx, opts)`:** runs each collector in its own `try/catch` under `withBudget` (default 1200 ms, split evenly).
  - A timed-out collector reports `error` / `detail: 'timeout'`, and its cursors are not committed.
  - For each collector, events and `pendingCursors` are committed **in one transaction**, and then its `afterCommit` runs (R-B5; the shell collector deletes its rotated files there, R-B6).
  - Events older than `retentionDays` are pruned at most once an hour.
  - Malformed counts arrive as collector warnings, and the last report is stored in `cursors('ingest','last_report')` (R-B10).
  - Waiting on another process's write lock must not crash (Review Focus 5).

Also in this commit:
- Task 7 approved and committed.
- Plan text: the "Tech Stack" and Task 15 doctor lines now say Node ≥ 22.15, and the Task 15 Codex storage-format warning (your decision after Task 7) is in the plan with its test.

## 2. Files

| File | Purpose |
|---|---|
| `src/collectors/registry.ts` | **New:** `collectors(config)` |
| `src/ingest/ingest.ts` | **New:** `ingest`, `IngestReport`, `SourceReport`, `CollectorName` |
| `src/store/repo.ts` | **Added** `Repo.transaction(fn)` (see §8.1) |
| `tests/ingest/ingest.test.ts` | **New:** 16 tests (fakes, the real shell collector, a real second process, all four real collectors) |
| `tests/store/repo.test.ts` | +3 tests for `transaction` |
| `docs/leftoff-implementation-plan.md` | Node ≥ 22.15 in Tech Stack and doctor; Task 15 Codex storage-format check and test |
| `docs/reports/task-08.md` | This report |
| `docs/reports/task-07.md` | §10 backfilled |
| `docs/PROGRESS.md` | Task 7 hash; Task 8 entry |

## 3. Interfaces produced

- **`collectors(config: Config): Collector[]`** (registry.ts). Used by `ingest`'s default and by Task 15's doctor/status.
- **`ingest(ctx: CollectContext, opts?: { budgetMs?: number; collectors?: Collector[] }): Promise<IngestReport>`**. `collectors` is a test seam that defaults to `collectors(ctx.config)`. Used by Task 10 (`resume`, budget 1200), Task 11 (`loops`), Task 12 (`internal summarize`), Task 13 (`session-start`, budget 1000), Task 14 (background ingest).
- **`interface IngestReport { perSource: Record<CollectorName, SourceReport>; prunedEvents: number }`**. It always has all four sources: a collector that didn't run (disabled) is `not_found` with `detail: 'disabled'`. Used by Task 9 (`sources` line) and Task 15 (doctor).
- **`interface SourceReport { status: 'ok' | 'not_found' | 'error'; inserted: number; warnings: string[]; detail?: string }`**
- **`type CollectorName = Exclude<Source, 'user'>`**: notes (`user`) come from no collector.
- **`Repo.transaction<T>(fn: () => T): T`**: runs `fn` in one SQLite transaction; nested calls become savepoints.
- **Stored:** `cursors('ingest','last_report')` = JSON `{ at, perSource, prunedEvents }`, and `cursors('ingest','last_prune')` = ISO time.

## 4. How it works

```ts
const list = opts.collectors ?? enabledCollectors(ctx.config);
const slice = (opts.budgetMs ?? 1200) / Math.max(list.length, 1);
for (const collector of list) perSource[collector.name] = await runOne(collector, ctx, slice);
const report = { perSource, prunedEvents: prune(ctx) };
ctx.repo.setCursor('ingest', 'last_report', JSON.stringify({ at: ctx.now.toISOString(), ...report }));
```

Collectors run **one after another**, each with an equal share of the budget, in the fixed order. Git runs last, so it sees projects the other collectors stored in the same run (tested: a shell command in a repo makes git collect that repo's commit).

`runOne`:

```ts
result = await withBudget(
  (async () => ((await collector.isAvailable(ctx)) ? collector.collect(ctx) : 'not_found'))(),
  budgetMs,
);                                                     // throw → status 'error', detail = message, logged
if (result === undefined) return { status: 'error', detail: 'timeout', … };   // never committed, even if it finishes later
if (result === 'not_found') return { status: 'not_found', … };
inserted = ctx.repo.transaction(() => {
  const n = ctx.repo.insertEvents(done.events);
  for (const c of done.pendingCursors) ctx.repo.setCursor(collector.name, c.key, c.value);
  return n;
});                                                    // throw → status 'error', nothing committed
await collector.afterCommit?.(ctx);                    // throw → warning only; data stays committed
return { status: 'ok', inserted, warnings };
```

- **One transaction:** if the insert succeeds but a cursor write fails, the events are rolled back too. Otherwise the next run would re-read the same data, and `afterCommit` would delete shell lines before their cursor was saved.
- **A timed-out collector's late result is discarded.** JavaScript can't cancel the work, but the result is simply never committed; the test waits past the late finish to check. Side effects already done (the shell collector's rename) are designed to be picked up on the next run.
- **`inserted`** counts only new rows: duplicates are skipped by dedupe keys.
- **Prune:** at most once an hour (`cursors('ingest','last_prune')`); deletes events with `ts` older than `now − retentionDays`.
- **Concurrency:** another process holding the write lock makes our writes wait (`busy_timeout` 2000 ms, Task 2). The test holds `BEGIN IMMEDIATE` in a real second process for 600 ms; ingest waits about 600 ms and succeeds.

## 5. Design decisions

| Decision | Alternatives | Why |
|---|---|---|
| Collectors run sequentially with equal slices | Parallel, each with the full budget | The plan says "split evenly"; sequential keeps SQLite writes serialized and order deterministic. See §9.1 for the drawback |
| `isAvailable` inside the collector's budget | Separate, unbounded | A hung `git --version` can't block ingest |
| `Repo.transaction` added | Give ingest the raw `Database`; one combined Repo method | Smallest generic addition that keeps ingest behind the storage interface (D9) |
| Late results discarded | Commit if they finish before ingest returns | A result that arrives after its budget ends is treated as never arriving; simpler and tested |
| `afterCommit` failure = warning | Mark the collector `error` | Its data is already committed and correct; cleanup is retried next run |
| All four sources always in the report | Only the ones run | Task 9's `Sources:` line and doctor need a value for each |
| Last report stored with its time | Without a time | Doctor can say how old the last ingest is |
| Prune uses `ctx.now` | `Date.now()` | Testable; same clock as the rest of the run |

## 6. Tests

**RED** (before implementation):

```
tests/store/repo.test.ts  → × transaction commits everything inside it together
                            × transaction rolls back events and cursors when it throws
                            × transaction returns the value of its function
tests/ingest/ingest.test.ts → Error: Cannot find module '../../src/collectors/registry.ts'
```

**Mutation checks** (code broken on purpose, then restored):

| Break | Caught by |
|---|---|
| No transaction around events + cursors | **survived at first**: in the "insert fails" test the cursor write comes after the failing insert, so nothing was written anyway. Added `events are rolled back when a cursor write fails after them` → caught |
| Budget not split | `the budget is split evenly between collectors` |
| Prune every run | `prunes old events at most hourly` |
| `afterCommit` never called | 3 tests (afterCommit count, warning, the real shell cleanup) |
| Report not stored | `last IngestReport with malformed warnings is stored in cursors` |

**Tests** (`tests/ingest/ingest.test.ts`, 16):

| Test | Proves |
|---|---|
| collectors(): enabled ones only, in order | Registry order and `config.collectors` |
| one collector throwing does not stop others *(plan)* | Error status, message as detail, logged; the next collector still runs |
| events and cursors are committed together; inserted excludes duplicates | Commit, counts, `afterCommit` once |
| cursor not committed when insert fails *(plan)* | All-or-nothing; no `afterCommit` |
| events are rolled back when a cursor write fails after them | The transaction (mutation-proven) |
| timeout marks collector error and keeps old cursor *(plan)* | Late result never committed |
| the budget is split evenly between collectors | 400 ms / 2: 150 ms fits, 300 ms times out |
| unavailable → not_found; not run → not_found "disabled" | All four keys present |
| an afterCommit failure is a warning | Data stays committed |
| collector warnings are passed through | |
| last IngestReport … stored in cursors *(plan, R-B10)* | |
| prunes old events at most hourly *(plan)* | 0 min: prune; +30 min: none; +61 min: prune |
| pruning uses retentionDays | |
| shell.log processed bytes are removed after commit; partial line kept *(plan, Review Focus 3)* | With the real shell collector |
| ingest waits for another process's write transaction *(plan, Review Focus 5)* | Real second process; waited ≥ 300 ms, succeeded |
| all four real collectors together, within the default budget | Real fixtures + shell log + git repo: claude 23, codex 33, shell 1, git 1 rows, all `ok`, < 1.5 s (≈ 350 ms) |

`tests/store/repo.test.ts` (+3): `transaction` commits together, rolls back together, returns the value.

**Final run** (`npm run check`):

```
> tsc --noEmit && eslint . && prettier --check . && vitest run --project unit
 Tests  332 passed | 1 skipped (333)
```

333 = 314 (Task 7) + 3 (repo) + 16 (ingest). The 1 skipped is the fish raw-tab test, by design.

## 7. Edge cases and failure handling

| Situation | Behavior |
|---|---|
| A collector throws | `error` with the message; logged; the others run |
| A collector hangs | `error` / `timeout` after its slice; its late result is discarded |
| Insert or cursor write fails | Whole commit rolled back; `error`; no `afterCommit` |
| `afterCommit` fails | Warning; data committed; cleanup retried next run (e.g. shell `*.ingesting` files are leftovers) |
| Collector source missing | `not_found` |
| Collector disabled in config | `not_found` / `disabled` |
| Another process holds the write lock < 2 s | Waits, then succeeds |
| Lock held > 2 s | That collector's commit throws `SQLITE_BUSY` → `error`; the others still try |
| Prune or the report write fails (DB unwritable) | **Throws out of `ingest`.** Callers (commands, hooks) must catch it: Tasks 10/13/14 wrap `ingest` |
| `budgetMs` with no collectors | No division by zero; just prune and report |

## 8. Deviations from the plan

1. **`Repo.transaction(fn)` added** to the storage interface (not in Task 2's list). It's needed for the plan's own requirement that events and cursors commit in one transaction. Ingest can't do that through `Repo` otherwise.
2. **`opts.collectors`** test seam on `ingest` (the plan's tests imply injecting collectors: `ingest(ctxWith([throwing, okCollector]))`).
3. **`IngestReport.perSource` is keyed by `CollectorName`** (the four collectors), not all `Source`s, because `user` has no collector. The plan's type `Record<Source, …>` would need a meaningless `user` entry.

## 9. Open questions and risks

1. **A big first backlog may never commit in the foreground. Please decide.** With 1200 ms split four ways, each collector gets 300 ms. On a machine with weeks of Claude transcripts, the claude collector's first run (up to 50 MB per file, many files) can exceed 300 ms every time. A timed-out collector commits nothing, so a foreground `resume` would never make progress. Background ingest (Task 12 summarize, Task 14 `brief --auto`) would catch up, because it can pass a bigger budget, so it's not fatal. But until then the brief lacks agent data, and Claude shows `!` (`error`).

   **Proposal:** a soft deadline in `CollectContext` (e.g. `deadline: number`). Collectors stop *starting* new files or projects once it passes, and return what they've done, so every run commits some progress; the hard timeout stays as a backstop. It's a small change in four collectors plus one test each. I did **not** do it, because it changes the `Collector` contract. Yes / no?
2. **The four-collector test reads fixture cwds** (`/private/tmp/leftoff-fixture` and `/private/tmp/leftoff-codex-fixture`). On your machine those folders exist as git repos. If you ever commit in them, the git collector would add those commits and the `git.inserted` count in that test would change. A cheap fix is to point the fixtures' cwd at the test's temp folder at test time. I'll do that if it ever bites; noting it.
3. **`ingest` throws if the database itself is unwritable** (prune or report write). Every caller must catch; I'll make sure Tasks 10, 13 and 14 do, and that their tests cover it.

## 10. Commit

To be filled in by Task 9's commit (B11). The commit message is `feat(ingest): isolated collector runs with transactional cursors`.
