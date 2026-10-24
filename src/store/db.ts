import { closeSync, existsSync, mkdirSync, openSync, renameSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';
import { logError } from '../core/logger.ts';
import { ensureHome, paths } from '../core/paths.ts';
import { migrate } from './migrations.ts';

export type { Database } from 'better-sqlite3';

// SQLite's answers for "this file is not a usable database".
const CORRUPT_CODES = new Set(['SQLITE_NOTADB', 'SQLITE_CORRUPT']);

function isCorruption(err: unknown): boolean {
  return CORRUPT_CODES.has((err as { code?: string })?.code ?? '');
}

const BUSY_TIMEOUT_MS = 2000;

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// Switching a new file to WAL needs an exclusive lock, and SQLite returns
// SQLITE_BUSY at once (without the busy handler) when two processes do it at
// the same moment. Retry for as long as busy_timeout would have waited.
function enableWal(db: Database.Database): void {
  const deadline = Date.now() + BUSY_TIMEOUT_MS;
  for (;;) {
    try {
      db.pragma('journal_mode = WAL');
      return;
    } catch (err) {
      if ((err as { code?: string }).code !== 'SQLITE_BUSY' || Date.now() >= deadline) throw err;
      sleepSync(10);
    }
  }
}

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

// Opens (creating if needed) the leftoff database. A file that SQLite says is
// not a database is moved to <file>.corrupt-<timestamp> and replaced (§1.11).
export function openDb(file?: string): Database.Database {
  if (file === undefined) {
    ensureHome();
    file = paths().db;
  } else {
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  }
  try {
    return open(file);
  } catch (err) {
    if (!isCorruption(err)) throw err;
    const aside = `${file}.corrupt-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    for (const suffix of ['', '-wal', '-shm']) {
      if (existsSync(file + suffix)) renameSync(file + suffix, aside + suffix);
    }
    logError('store', `database ${file} is corrupt (${String(err)}); moved to ${aside}`);
    return open(file);
  }
}
