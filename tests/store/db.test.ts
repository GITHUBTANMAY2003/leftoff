import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { readRecentErrors } from '../../src/core/logger.ts';
import { openDb } from '../../src/store/db.ts';
import { MIGRATIONS } from '../../src/store/migrations.ts';
import { createRepo } from '../../src/store/repo.ts';
import { ev } from './helpers.ts';

let dir: string;
let file: string;
const savedHome = process.env.LEFTOFF_HOME;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'leftoff-db-'));
  file = join(dir, 'leftoff.db');
  process.env.LEFTOFF_HOME = dir;
});

afterEach(() => {
  if (savedHome === undefined) delete process.env.LEFTOFF_HOME;
  else process.env.LEFTOFF_HOME = savedHome;
  rmSync(dir, { recursive: true, force: true });
});

test('openDb defaults to paths().db and creates the home directory', () => {
  const home = join(dir, 'fresh-home');
  process.env.LEFTOFF_HOME = home;
  const db = openDb();
  expect(db.name).toBe(join(home, 'leftoff.db'));
  expect(statSync(home).mode & 0o777).toBe(0o700);
  db.close();
});

test('openDb enables WAL, busy_timeout 2000 and the current schema version', () => {
  const db = openDb(file);
  expect(db.pragma('journal_mode', { simple: true })).toBe('wal');
  expect(db.pragma('busy_timeout', { simple: true })).toBe(2000);
  expect(db.pragma('user_version', { simple: true })).toBe(MIGRATIONS.length);
  db.close();
});

test('db file is created with mode 0600', () => {
  openDb(file).close();
  expect(statSync(file).mode & 0o777).toBe(0o600);
});

test('reopening a valid database keeps its data', () => {
  const db = openDb(file);
  createRepo(db).insertEvents([ev('a')]);
  db.close();
  const again = openDb(file);
  expect(createRepo(again).eventsSince('2000-01-01T00:00:00.000Z')).toHaveLength(1);
  expect(readdirSync(dir).some((f) => f.includes('corrupt'))).toBe(false);
  again.close();
});

test('corrupt db file is moved aside and recreated', () => {
  writeFileSync(file, 'garbage');
  const db = openDb(file);
  expect(readdirSync(dir).some((f) => f.startsWith('leftoff.db.corrupt-'))).toBe(true);
  expect(createRepo(db).projects()).toEqual([]);
  expect(readRecentErrors(1)[0]).toMatch(/corrupt/);
  db.close();
});

test('a database from a newer leftoff is refused, not moved aside', () => {
  const raw = new Database(file);
  raw.pragma(`user_version = ${MIGRATIONS.length + 1}`);
  raw.close();
  expect(() => openDb(file)).toThrow(/newer/);
  expect(existsSync(file)).toBe(true);
  expect(readdirSync(dir).some((f) => f.includes('corrupt'))).toBe(false);
});

function runWriter(
  dbFile: string,
  id: string,
  count: number,
): Promise<{ code: number | null; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      [
        // Node 22/24 print an ExperimentalWarning for type stripping on stderr.
        '--disable-warning=ExperimentalWarning',
        join(import.meta.dirname, 'concurrent-writer.ts'),
        dbFile,
        id,
        String(count),
      ],
      { stdio: ['ignore', 'ignore', 'pipe'] },
    );
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
    child.on('close', (code) => resolve({ code, stderr }));
  });
}

test('concurrent writers from two processes do not throw SQLITE_BUSY', async () => {
  const results = await Promise.all([runWriter(file, 'A', 500), runWriter(file, 'B', 500)]);
  for (const r of results) expect(r).toEqual({ code: 0, stderr: '' });
  const db = openDb(file);
  expect(createRepo(db).projects()[0]?.count).toBe(1000);
  db.close();
}, 30_000);

test('two processes creating the same new database at once both succeed', async () => {
  // The race (both switching a fresh file to WAL) only happens on creation,
  // and not every time, so repeat it on fresh files.
  for (let round = 0; round < 5; round++) {
    const fresh = join(dir, `race-${round}.db`);
    const results = await Promise.all([runWriter(fresh, 'A', 1), runWriter(fresh, 'B', 1)]);
    for (const r of results) expect(r).toEqual({ code: 0, stderr: '' });
  }
}, 30_000);
