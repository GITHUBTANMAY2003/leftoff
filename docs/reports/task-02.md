# Task 02: SQLite store and repository

## 1. Goal

From the plan (Task 2): the single local SQLite file `~/.leftoff/leftoff.db` (D9, §1.4) behind a storage interface:

- **`openDb`:** WAL, `busy_timeout = 2000`, schema versioned with `PRAGMA user_version`, and corruption recovery: "move it to `leftoff.db.corrupt-<timestamp>`, create a fresh one, log it" (§1.11).
- **`Repo`:** the operations every later task uses: events with dedupe, cursors, cached briefs, "brief shown" markers, leases (locks), pruning and deletion.

Review Focus 5 (concurrency, "no 'database is locked' crash") is tested here.

Folded into this commit at the owner's request: **count-type config keys must be integers ≥ 0** (`retentionDays`, `looseEnds.maxProjects`, `ingest.maxBytesPerFilePerRun`, `codex.maxCompressedMb`). `config set` rejects decimals for them; durations stay decimal.

## 2. Files

| File | Purpose |
|---|---|
| `src/model/event.ts` | **New, type-only** (as the plan says for Task 2): `Source`, `EventKind`, `WorkEvent` from §1.5. Task 3 adds the logic |
| `src/store/migrations.ts` | Schema v1 as `MIGRATIONS[0]`; `migrate(db)`; `SchemaTooNewError` |
| `src/store/db.ts` | `openDb()`: file creation with mode 600, busy timeout, WAL (with retry), migrations, corruption recovery |
| `src/store/repo.ts` | `Repo` interface + `createRepo(db)` SQLite implementation |
| `tests/store/db.test.ts` | 8 tests: open, pragmas, file mode, reopen, corruption, newer schema, two concurrency tests |
| `tests/store/repo.test.ts` | 19 tests for every `Repo` method |
| `tests/store/helpers.ts` | `ev(key, overrides)`: builds a valid `WorkEvent` for tests |
| `tests/store/concurrent-writer.ts` | Child-process script for the concurrency tests, run by Node directly via type stripping (R-A5) |
| `src/core/config.ts` | **Changed:** new `integer` kind for the four count keys |
| `tests/core/config.test.ts` | **Changed:** 8 new tests for the integer rule |
| `package.json`, `package-lock.json` | Adds `better-sqlite3@^13.0.3` (runtime) and `@types/better-sqlite3@^9.6.0` (dev) |
| `docs/reports/task-02.md` | This report |
| `docs/reports/task-01.md` | §10 backfilled with Task 1's commit |
| `docs/PROGRESS.md` | Task 1 hash backfilled, Task 2 marked done |

## 3. Interfaces produced

**`src/model/event.ts`** (type-only for now; Task 3 completes it)

- `type Source = 'git' | 'shell' | 'claude' | 'codex' | 'user'`
- `type EventKind`: the 13 kinds from §1.5
- `interface WorkEvent { source; kind; projectRoot; ts; sessionRef; summary; data; dedupeKey }`, exactly §1.5

Used by Tasks 3–16.

**`src/store/db.ts`**

- `openDb(file?: string): Database` opens or creates the database. With no argument it uses `paths().db` and calls `ensureHome()` first; with a path it creates the parent directory (mode 700).
  - It applies `busy_timeout = 2000` and WAL, then runs the migrations.
  - It moves a corrupt file aside and recreates it.
  - It throws `SchemaTooNewError` if the file comes from a newer leftoff.

  Used by Task 8 (ingest), Tasks 10–15 (all commands), Task 12 (summarize), Task 13 (hooks), Task 14 (`brief --auto`).
- `export type { Database } from 'better-sqlite3'`, re-exported so callers don't import `better-sqlite3` directly.

**`src/store/migrations.ts`**

- `MIGRATIONS: string[]`: `MIGRATIONS[i]` upgrades version `i` → `i + 1`. Today there is one entry, the v1 schema from the plan.
- `migrate(db: Database): void` applies the missing migrations inside one `BEGIN IMMEDIATE` transaction. Used only by `openDb`. Task 15's doctor can compare `user_version` with `MIGRATIONS.length` ("`user_version` current").
- `class SchemaTooNewError extends Error`.

**`src/store/repo.ts`**

- `interface StoredBrief { factsHash: string; polished: string | null; provider: string | null; createdAt: string }`
- `interface Repo` and `createRepo(db: Database): Repo`, with exactly the methods the plan lists:

| Method | Description | Used by |
|---|---|---|
| `insertEvents(events: WorkEvent[]): number` | One transaction, skips duplicate `dedupeKey`s, returns how many were inserted. **All-or-nothing:** an invalid event throws and inserts nothing | Task 8, notes (10), hooks (13) |
| `eventsForProject(root, sinceIso): WorkEvent[]` | Events of one project with `ts >= sinceIso`, ascending by `ts` (ties by insertion order) | Tasks 9, 10, 11, 13, 14 |
| `eventsSince(sinceIso): WorkEvent[]` | All projects, same ordering | Task 11 (standup) |
| `projects(): { root; lastTs; count }[]` | One row per project, **most recently active first** | Tasks 5, 11 (loose ends `maxProjects`), 15 (`status`) |
| `lastActivity(root): string \| null` | Newest event `ts` for the project | Task 14 (`isBriefDue`) |
| `getCursor(collector, key): string \| null` / `setCursor(collector, key, value): void` | Read / upsert a cursor (`updated_at` set to now) | Tasks 4–8, 14 |
| `saveBrief(root, factsHash, factsJson, polished, provider): void` / `getBrief(root): StoredBrief \| null` | Cache of the last facts and polished text per project (`created_at` = now) | Tasks 10, 12 |
| `markBriefShown(root, activityIso): void` / `briefShownFor(root): string \| null` | Records which activity time a brief was last shown for | Tasks 10, 14 |
| `acquireLock(name, holder, ttlMs): boolean` / `releaseLock(name, holder): void` | Lease: free, expired, or already held by the same holder → `true` | Task 12 (summarize), Task 14 (background ingest) |
| `pruneOlderThan(iso): number` | Deletes events with `ts < iso`, returns the count | Task 8 |
| `deleteProject(root): void` | Deletes the project's events, brief and shown marker | Task 15 (`forget --project`) |
| `deleteAll(): void` | Deletes all events, briefs, shown markers and locks; **keeps cursors** (see §5) | Task 15 (`forget --all`) |

**`src/core/config.ts`** has no new exports. The behavior change: the four count keys accept only integers ≥ 0, both from `config set` and from `config.json`.

## 4. How it works

### Opening the database

```ts
function open(file: string): Database.Database {
  if (!existsSync(file)) closeSync(openSync(file, 'a', 0o600)); // SQLite keeps this mode
  const db = new Database(file);
  try {
    db.pragma(`busy_timeout = ${BUSY_TIMEOUT_MS}`); // first, so everything below waits for locks
    enableWal(db);
    migrate(db);
    return db;
  } catch (err) {
    db.close();
    throw err;
  }
}
```

1. **File mode:** the empty file is created with mode `600` *before* SQLite opens it, so there's never a moment where the database is readable by others. SQLite creates `-wal` and `-shm` with the same mode as the database file.
2. **`busy_timeout` first:** every later statement (WAL switch, migrations) then waits up to 2 s for a lock instead of failing.
3. **WAL with retry** (see "The bug the tests found" below).
4. **Migrations.**

### Corruption recovery

```ts
try {
  return open(file);
} catch (err) {
  if (!isCorruption(err)) throw err;          // only SQLITE_NOTADB / SQLITE_CORRUPT
  const aside = `${file}.corrupt-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  for (const suffix of ['', '-wal', '-shm']) {
    if (existsSync(file + suffix)) renameSync(file + suffix, aside + suffix);
  }
  logError('store', `database ${file} is corrupt (${String(err)}); moved to ${aside}`);
  return open(file);
}
```

- Only the two error codes that mean "this is not a usable database" trigger the move. Anything else is re-thrown and the user's data stays where it is: a lock timeout, a permission error, or a schema from a newer leftoff.
- The `-wal` and `-shm` files are moved together with the database, so a stale WAL can't be replayed into the fresh file.
- Example name: `leftoff.db.corrupt-2026-10-24T17-39-13-123Z`.

### Migrations

```ts
export function migrate(db: Database): void {
  const version = () => db.pragma('user_version', { simple: true }) as number;
  if (version() > MIGRATIONS.length) throw new SchemaTooNewError(`database schema v${version()} is newer ...`);
  db.transaction(() => {
    for (let v = version(); v < MIGRATIONS.length; v++) {
      db.exec(MIGRATIONS[v] as string);
      db.pragma(`user_version = ${v + 1}`);
    }
  }).immediate();
}
```

`BEGIN IMMEDIATE` takes the write lock before reading the version. When two processes open a brand-new file at the same moment, the second one waits (`busy_timeout`), then re-reads `user_version = 1` and applies nothing. The schema and the version bump are committed together, so a crash mid-migration leaves the previous version intact.

### Inserting events

```ts
const insertEvent = db.prepare(
  `INSERT INTO events(${EVENT_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
   ON CONFLICT(dedupe_key) DO NOTHING`,
);
const insertAll = db.transaction((events: WorkEvent[]) => {
  let inserted = 0;
  for (const e of events) inserted += insertEvent.run(..., JSON.stringify(e.data), e.dedupeKey).changes;
  return inserted;
});
```

The plan says `INSERT OR IGNORE`. I used `ON CONFLICT(dedupe_key) DO NOTHING` instead, because a test showed that `INSERT OR IGNORE` also silently skips rows that violate `NOT NULL` (see §6 and §8). `data` is stored as JSON text (plan Step 3) and parsed back into an object on read.

### Locks (leases)

```ts
const acquireLock = db.prepare(
  `INSERT INTO locks(name, holder, expires_at) VALUES (?, ?, ?)
   ON CONFLICT(name) DO UPDATE SET holder = excluded.holder, expires_at = excluded.expires_at
   WHERE locks.expires_at <= ? OR locks.holder = excluded.holder`,
);
// acquireLock(name, holder, ttlMs) → run(name, holder, now + ttl, now).changes === 1
```

- A single SQL statement makes the check and the take atomic across processes, with no read-then-write race.
- The upsert reports `changes = 1` when it inserted a new lock or replaced an expired or same-holder one, and `0` when someone else holds a live lock.
- Times are ISO 8601 UTC strings of fixed width, so string comparison equals time comparison.

### Integer config keys

```ts
case 'integer':   // config set
  if (!/^\d+$/.test(s) || !Number.isSafeInteger(Number(s))) {
    throw new Error(`${key} must be an integer (a whole number ≥ 0), got "${raw}"`);
  }
  return Number(s);
...
case 'integer':   // config.json
  return Number.isSafeInteger(v) && (v as number) >= 0;
```

A decimal (or a number too large to be exact) for a count key is rejected by `config set`. In `config.json` it falls back to the default with a log line, the same as any other invalid value.

### The bug the tests found: concurrent creation and WAL

The plan's concurrency test passed on its first run and then failed intermittently:

```
SqliteError: database is locked
    at open (file:///Users/apple/leftoff/src/store/db.ts:22:8)     ← db.pragma('journal_mode = WAL')
    at openDb (file:///Users/apple/leftoff/src/store/db.ts:41:12)
  code: 'SQLITE_BUSY'
```

The cause: switching a **new** database to WAL needs an exclusive lock. When two processes do it at the same moment, SQLite returns `SQLITE_BUSY` immediately, without calling the busy handler, so `busy_timeout` doesn't help. WAL mode is persistent in the file, so this only happens when two processes *create* the database at the same time. In real use that's, for example, two Claude Code sessions starting before leftoff has ever run.

Following TDD, I first added a test that repeats the race 5 times on fresh files. It failed in 3 of 3 runs. Then the fix:

```ts
function enableWal(db: Database.Database): void {
  const deadline = Date.now() + BUSY_TIMEOUT_MS;
  for (;;) {
    try {
      db.pragma('journal_mode = WAL');
      return;
    } catch (err) {
      if ((err as { code?: string }).code !== 'SQLITE_BUSY' || Date.now() >= deadline) throw err;
      sleepSync(10);   // Atomics.wait: a synchronous 10 ms pause
    }
  }
}
```

After the fix: 10 of 10 runs passed.

## 5. Design decisions

| Decision | Alternatives | Why |
|---|---|---|
| `ON CONFLICT(dedupe_key) DO NOTHING` instead of `INSERT OR IGNORE` | Plan's `INSERT OR IGNORE` | `OR IGNORE` also skips NOT NULL violations silently; a broken collector would lose events with no error, and Task 8's "cursor not committed when insert fails" relies on inserts throwing. Same dedupe behavior otherwise |
| `insertEvents` is all-or-nothing | Insert the valid ones | One transaction (plan); Task 8 commits cursors in the same transaction, so partial inserts would skip data |
| WAL switch retried for up to 2 s on `SQLITE_BUSY` | Ignore the error; a file lock around creation | Fixes the real race found in testing with no extra files; the retry window equals `busy_timeout` |
| Synchronous sleep via `Atomics.wait` | `await` a timer | `better-sqlite3` and `openDb` are synchronous; callers shouldn't have to become async for a first-run edge case |
| `busy_timeout` set explicitly to 2000 | Rely on better-sqlite3's own default (5000 ms) | §1.11 says 2000; hooks have 500 ms–2 s budgets, so waiting 5 s would blow them |
| Database file pre-created with mode 600 | `chmod` after SQLite creates it | No window where the database is world-readable; SQLite copies the mode to `-wal`/`-shm` |
| Only `SQLITE_NOTADB` / `SQLITE_CORRUPT` trigger the move | Move aside on any open error | Never throw away a valid database because it was locked, unreadable, or from a newer leftoff |
| A newer schema throws `SchemaTooNewError` | Open anyway; move aside | Opening could corrupt data a newer leftoff wrote; moving aside would lose it. The user should upgrade |
| Migrations use `BEGIN IMMEDIATE` and re-read the version | Plain transaction | Two processes creating the database at once must not both run v1 (`CREATE TABLE` would fail) |
| `projects()` ordered by `lastTs` descending | Unordered, or by name | Loose ends (§1.7) checks "the `maxProjects` most recently active first"; `status` reads naturally |
| Events ordered by `ts`, ties by `id` (insertion order) | `ts` only | Deterministic order for events with the same timestamp (common for multiple tool uses in one record) |
| `acquireLock` lets the same holder renew | Fail for the same holder | A long summarize can extend its lease; harmless otherwise |
| `releaseLock` only deletes when the holder matches | Delete by name | A process whose lease expired and was taken over must not release the new holder's lock |
| `deleteAll` and `deleteProject` keep cursors | Delete cursors too | Deleting cursors would make the next ingest re-import the transcripts and shell history the user just asked to forget. **Needs your confirmation; see §9** |
| `deleteProject` also removes the cached brief and shown marker | Events only | Forgetting a project shouldn't leave its last brief behind |
| `@types/better-sqlite3@9.6.0` with `better-sqlite3@13` | No types | Latest published types; the API we use (`prepare`, `pragma`, `transaction`, `.immediate()`) is unchanged. `tsc` passes |
| Child process runs `.ts` with `--disable-warning=ExperimentalWarning` | No flag | Node 22 and 24 print an ExperimentalWarning for type stripping on stderr, and the test asserts empty stderr. Node 26 (local) doesn't print it |
| Integer keys: `Number.isSafeInteger` | `Number.isInteger` | Also rejects values like `1e20` that can't be represented exactly |
| Integer error message names both "integer" and "whole number ≥ 0" | Only "integer" | Readable for non-programmers, and keeps the earlier `/number/` test passing |

## 6. Tests

**RED: the run before the store existed** (`npx vitest run --project unit tests/store`):

```
 FAIL  |unit| tests/store/db.test.ts [ tests/store/db.test.ts ]
Error: Cannot find module '../../src/store/db.ts' imported from /Users/apple/leftoff/tests/store/db.test.ts
 FAIL  |unit| tests/store/repo.test.ts [ tests/store/repo.test.ts ]
Error: Cannot find module '../../src/store/db.ts' imported from /Users/apple/leftoff/tests/store/repo.test.ts
 Test Files  2 failed (2)
```

**RED: the integer config rule** (5 new tests failed before the change; the 3 duration tests passed because they guard behavior that must stay):

```
   × setConfigValue: count key retentionDays accepts integers and rejects decimals
   × setConfigValue: count key looseEnds.maxProjects accepts integers and rejects decimals
   × setConfigValue: count key ingest.maxBytesPerFilePerRun accepts integers and rejects decimals
   × setConfigValue: count key codex.maxCompressedMb accepts integers and rejects decimals
   × a decimal for a count key in the file falls back to its default with a log line
AssertionError: expected [Function] to throw an error
AssertionError: expected 7.5 to be 30
      Tests  5 failed | 19 passed (24)
```

**Two failures found during GREEN that changed the code:**
1. `insertEvents is all-or-nothing` failed with `INSERT OR IGNORE` (`expected [Function] to throw an error`), which led to the `ON CONFLICT … DO NOTHING` change.
2. `SQLITE_BUSY` on concurrent creation (see §4). Reproduced in 3 of 3 runs by the new race test, then fixed and passing in 10 of 10 runs.

**Mutation checks** (code broken on purpose, then restored):

| Break | Test that caught it |
|---|---|
| Removed the `busy_timeout` pragma | `openDb enables WAL, busy_timeout 2000 …`. The concurrency test alone did **not** catch it, because better-sqlite3 falls back to its own 5000 ms timeout. That's why the explicit pragma test exists |
| Re-throw instead of corruption recovery | `corrupt db file is moved aside and recreated` |
| Locks never expire | `expired lock can be taken` |
| `deleteProject` deletes only events | `deleteProject removes only that project (events, brief, shown marker)` |
| `eventsForProject` ordered by `id` instead of `ts` | `eventsForProject returns ascending ts …` |
| `INSERT OR IGNORE` (the plan's wording) | `insertEvents is all-or-nothing` (observed during GREEN) |
| No WAL retry | `two processes creating the same new database at once both succeed` (observed during GREEN) |

**Tests and what each proves.** *(plan)* = named in the plan.

`tests/store/db.test.ts`

| Test | Proves |
|---|---|
| openDb defaults to paths().db and creates the home directory | No-argument form uses `LEFTOFF_HOME`, and home gets mode 700 |
| openDb enables WAL, busy_timeout 2000 and the current schema version | §1.11 pragmas; migrations ran |
| db file is created with mode 0600 | P4 |
| reopening a valid database keeps its data | Normal reopen doesn't trigger recovery or lose data |
| corrupt db file is moved aside and recreated *(plan)* | §1.11 recovery, a usable empty database, and a log line |
| a database from a newer leftoff is refused, not moved aside | Downgrade safety |
| concurrent writers from two processes do not throw SQLITE_BUSY *(plan)* | 2 processes × 500 single-event transactions → 1000 rows, both exit 0 with empty stderr (Review Focus 5) |
| two processes creating the same new database at once both succeed | Regression test for the WAL/creation race; 5 fresh files |

`tests/store/repo.test.ts`

| Test | Proves |
|---|---|
| insertEvents ignores duplicates by dedupeKey *(plan)* | Duplicates within one batch and across batches; return value = inserted count |
| insertEvents is all-or-nothing: one bad event inserts none | Transactional insert; invalid rows throw |
| events round-trip with all fields, data as an object | Column mapping, `null` sessionRef, nested `data` JSON |
| eventsForProject returns ascending ts for that project only, since inclusive *(plan)* | Filtering by project and time; ordering |
| eventsSince returns all projects in ts order | Cross-project query |
| projects lists root, last ts and count, most recently active first | Aggregation and ordering |
| lastActivity is the newest ts, or null for an unknown project | |
| cursor round-trip *(plan)* | |
| cursor overwrite, separation by collector, and missing cursor | Upsert; `(collector, key)` key; `null` default |
| saveBrief / getBrief round-trip and overwrite | Upsert; `createdAt` set |
| markBriefShown / briefShownFor | Upsert; per project |
| lock: second holder fails until expiry *(plan)* | |
| expired lock can be taken *(plan)* | ttl 1 ms, wait 5 ms, B succeeds, and A is then locked out |
| released lock can be taken; only the holder can release | |
| the current holder can renew its lock | |
| locks with different names are independent | Per-project summarize leases don't block each other |
| pruneOlderThan removes old events only *(plan)* | Across projects; returns the count |
| deleteProject removes only that project (events, brief, shown marker) | |
| deleteAll removes events, briefs, shown markers and locks, but keeps cursors | |

`tests/core/config.test.ts` (new tests)

| Test | Proves |
|---|---|
| setConfigValue: count key %s accepts integers and rejects decimals (×4) | Default is an integer, `0` accepted, `2.5` rejected with "integer" |
| setConfigValue: duration key %s accepts decimals (×3) | `gapHours`, `sessionGapMinutes`, `staleDays` still take `0.5` |
| a decimal for a count key in the file falls back to its default with a log line | `retentionDays: 7.5` → 30 and logged, while `sessionGapMinutes: 30.5` is kept |

**Final run** (`npm run check`):

```
> tsc --noEmit && eslint . && prettier --check . && vitest run --project unit

Checking formatting...
All matched files use Prettier code style!

 Test Files  6 passed (6)
      Tests  69 passed (69)
   Duration  1.08s
```

Counts: 42 core tests (Task 1's 34 + 8 integer tests) + 27 store tests = 69. The two child-process tests account for most of the 1 s.

## 7. Edge cases and failure handling

| Situation | Behavior |
|---|---|
| Database file missing | Created (mode 600), WAL, schema v1 |
| Database file is garbage / not SQLite | Moved to `leftoff.db.corrupt-<ts>` (with `-wal`/`-shm`), logged, fresh database |
| Database from a newer leftoff (`user_version` > known) | `SchemaTooNewError`, file untouched. Callers (hooks) must catch it and exit 0; that's their job in Tasks 13/14 |
| Database locked by another writer | Statements wait up to 2 s (`busy_timeout`), then throw `SQLITE_BUSY`; callers decide (ingest reports the collector as `error`) |
| Two processes creating the database at the same moment | Both succeed: WAL switch retried, migration serialized by `BEGIN IMMEDIATE` |
| Crash in the middle of a migration | Transaction rolls back; `user_version` unchanged; retried on the next open |
| Crash in the middle of `insertEvents` | Transaction rolls back; nothing inserted |
| Duplicate events (re-reading the same log) | Skipped by `dedupe_key`; not counted |
| Invalid event (e.g. missing summary) | Throws; nothing from that batch inserted |
| Lock holder crashes without releasing | Lock expires after its ttl (120 s for summarize, per plan); then anyone can take it |
| Expired holder tries to release after someone else took over | No effect (holder must match) |
| Corrupt JSON in an `events.data` cell | Not possible through `Repo` (written with `JSON.stringify`). If someone edits the file by hand, `JSON.parse` throws on read. Not handled; see §9 |
| Parent directory of a custom db path missing | Created with mode 700 |

## 8. Deviations from the plan

1. **`ON CONFLICT(dedupe_key) DO NOTHING` instead of `INSERT OR IGNORE`.** The behavior the plan wants (ignore duplicates by `dedupe_key`, return the inserted count, one transaction) is unchanged. The only difference: rows that violate `NOT NULL` now throw instead of disappearing silently. A test found it; see §4 and §6.
2. **WAL switch retry.** Not in the plan; needed to meet the plan's own concurrency requirement (Review Focus 5) on database creation.
3. **Extra files:** `tests/store/helpers.ts` (event builder) and `tests/store/concurrent-writer.ts` (the child process the plan's concurrency test spawns). Both are test support files the plan's tests imply but don't name.
4. **Config integer rule.** Requested by the owner and folded into this commit. The plan text for Task 1 (R-B9) doesn't mention integers yet. I'll add one line to the plan when you confirm, or now if you prefer.

## 9. Open questions and risks

1. **Should `forget` keep cursors? Please decide (affects Task 15).** I keep them in `deleteAll`/`deleteProject`, so `leftoff forget --all` doesn't immediately re-import the forgotten history on the next ingest. The cost: the cursor table still holds file paths (e.g. `~/.claude/projects/-Users-apple-myapp/<id>.jsonl`) and the last commit hash per project root. If you want `forget` to leave nothing behind, Task 15 can delete cursors **and** set a "forgotten before <time>" marker that collectors respect. That would be more work and a plan change.
2. **Child-process tests need Node ≥ 22.18** (built-in type stripping without a flag). CI uses the latest 22.x, so this is fine. The *product* still supports Node 22.12, because the shipped code is bundled JavaScript. Only these tests need the newer Node.
3. **The ExperimentalWarning fix is untested on Node 22/24.** I couldn't verify it locally (Node 26 doesn't print the warning) and installing other Node versions needs your OK. If CI fails on those jobs with a stderr mismatch in `tests/store/db.test.ts`, that's the place to look.
4. **Corrupt JSON inside an event row would throw on read.** It can only happen by editing the database by hand. If you want, Task 8 or 9 could skip such rows and log them; for now I'd leave it.
5. **Plan text.** Note the integer rule (§8.4) and the `ON CONFLICT` wording (§8.1) in the plan? Proposed: one line each in Task 1's config paragraph and Task 2's interface list.

## 10. Commit

To be filled in by Task 3's commit (B11). The commit message is `feat(store): sqlite repo with migrations, locks, corruption recovery`.
