import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Database } from 'better-sqlite3';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { readRecentErrors } from '../../src/core/logger.ts';
import { openDb } from '../../src/store/db.ts';
import { createRepo, type Repo } from '../../src/store/repo.ts';
import { ev } from './helpers.ts';

let dir: string;
let db: Database;
let repo: Repo;
const savedHome = process.env.LEFTOFF_HOME;
const EPOCH = '2000-01-01T00:00:00.000Z';

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'leftoff-repo-'));
  process.env.LEFTOFF_HOME = dir;
  db = openDb(join(dir, 'leftoff.db'));
  repo = createRepo(db);
});

afterEach(() => {
  db.close();
  if (savedHome === undefined) delete process.env.LEFTOFF_HOME;
  else process.env.LEFTOFF_HOME = savedHome;
  rmSync(dir, { recursive: true, force: true });
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test('insertEvents ignores duplicates by dedupeKey', () => {
  expect(repo.insertEvents([ev('a'), ev('a'), ev('b')])).toBe(2);
  expect(repo.insertEvents([ev('b'), ev('c')])).toBe(1);
});

test('insertEvents is all-or-nothing: one bad event inserts none', () => {
  const bad = { ...ev('bad'), summary: null } as unknown as ReturnType<typeof ev>;
  expect(() => repo.insertEvents([ev('ok'), bad])).toThrow();
  expect(repo.eventsSince(EPOCH)).toEqual([]);
});

test('rows whose data JSON cannot be parsed are skipped and logged once per read', () => {
  repo.insertEvents([ev('good', { ts: '2026-10-20T10:00:00.000Z' })]);
  const raw = db.prepare(
    `INSERT INTO events(source, kind, project_root, ts, session_ref, summary, data, dedupe_key)
     VALUES ('shell', 'command', '/p', ?, NULL, 's', ?, ?)`,
  );
  raw.run('2026-10-20T11:00:00.000Z', '{broken', 'bad-1');
  raw.run('2026-10-20T12:00:00.000Z', 'not json', 'bad-2');

  expect(repo.eventsForProject('/p', EPOCH).map((e) => e.dedupeKey)).toEqual(['good']);
  expect(readRecentErrors(10)).toHaveLength(1);
  expect(readRecentErrors(1)[0]).toMatch(/skipped 2 events.*bad-1/);

  expect(repo.eventsSince(EPOCH).map((e) => e.dedupeKey)).toEqual(['good']);
  expect(readRecentErrors(10)).toHaveLength(2);
});

test('a read with only valid rows logs nothing', () => {
  repo.insertEvents([ev('a'), ev('b')]);
  repo.eventsForProject('/p', EPOCH);
  repo.eventsSince(EPOCH);
  expect(readRecentErrors(10)).toEqual([]);
});

test('events round-trip with all fields, data as an object', () => {
  const e = ev('a', {
    source: 'claude',
    kind: 'command_failed',
    sessionRef: null,
    data: { exitCode: 1, nested: { list: [1, 2] } },
  });
  repo.insertEvents([e]);
  expect(repo.eventsSince(EPOCH)).toEqual([e]);
});

test('eventsForProject returns ascending ts for that project only, since inclusive', () => {
  repo.insertEvents([
    ev('late', { ts: '2026-10-20T12:00:00.000Z' }),
    ev('early', { ts: '2026-10-20T09:00:00.000Z' }),
    ev('too-early', { ts: '2026-10-19T09:00:00.000Z' }),
    ev('other', { projectRoot: '/q', ts: '2026-10-20T10:00:00.000Z' }),
    ev('mid', { ts: '2026-10-20T10:00:00.000Z' }),
  ]);
  const keys = repo.eventsForProject('/p', '2026-10-20T09:00:00.000Z').map((e) => e.dedupeKey);
  expect(keys).toEqual(['early', 'mid', 'late']);
});

test('eventsSince returns all projects in ts order', () => {
  repo.insertEvents([
    ev('q', { projectRoot: '/q', ts: '2026-10-20T11:00:00.000Z' }),
    ev('p', { ts: '2026-10-20T10:00:00.000Z' }),
    ev('old', { ts: '2026-10-01T10:00:00.000Z' }),
  ]);
  expect(repo.eventsSince('2026-10-20T00:00:00.000Z').map((e) => e.dedupeKey)).toEqual(['p', 'q']);
});

test('projects lists root, last ts and count, most recently active first', () => {
  repo.insertEvents([
    ev('p1', { ts: '2026-10-20T10:00:00.000Z' }),
    ev('p2', { ts: '2026-10-20T08:00:00.000Z' }),
    ev('q1', { projectRoot: '/q', ts: '2026-10-21T10:00:00.000Z' }),
  ]);
  expect(repo.projects()).toEqual([
    { root: '/q', lastTs: '2026-10-21T10:00:00.000Z', count: 1 },
    { root: '/p', lastTs: '2026-10-20T10:00:00.000Z', count: 2 },
  ]);
});

test('lastActivity is the newest ts, or null for an unknown project', () => {
  repo.insertEvents([
    ev('a', { ts: '2026-10-20T10:00:00.000Z' }),
    ev('b', { ts: '2026-10-20T12:00:00.000Z' }),
  ]);
  expect(repo.lastActivity('/p')).toBe('2026-10-20T12:00:00.000Z');
  expect(repo.lastActivity('/nope')).toBeNull();
});

test('cursor round-trip', () => {
  repo.setCursor('claude', '/f.jsonl', '123');
  expect(repo.getCursor('claude', '/f.jsonl')).toBe('123');
});

test('cursor overwrite, separation by collector, and missing cursor', () => {
  repo.setCursor('claude', '/f.jsonl', '123');
  repo.setCursor('claude', '/f.jsonl', '456');
  repo.setCursor('codex', '/f.jsonl', '9');
  expect(repo.getCursor('claude', '/f.jsonl')).toBe('456');
  expect(repo.getCursor('codex', '/f.jsonl')).toBe('9');
  expect(repo.getCursor('claude', '/other')).toBeNull();
});

test('saveBrief / getBrief round-trip and overwrite', () => {
  expect(repo.getBrief('/p')).toBeNull();
  repo.saveBrief('/p', 'h1', '{}', null, null);
  repo.saveBrief('/p', 'h2', '{"a":1}', 'Polished text.', 'claude-cli');
  const b = repo.getBrief('/p');
  expect(b).toMatchObject({ factsHash: 'h2', polished: 'Polished text.', provider: 'claude-cli' });
  expect(b?.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
});

test('markBriefShown / briefShownFor', () => {
  expect(repo.briefShownFor('/p')).toBeNull();
  repo.markBriefShown('/p', '2026-10-20T10:00:00.000Z');
  repo.markBriefShown('/p', '2026-10-21T10:00:00.000Z');
  expect(repo.briefShownFor('/p')).toBe('2026-10-21T10:00:00.000Z');
  expect(repo.briefShownFor('/q')).toBeNull();
});

test('lock: second holder fails until expiry', () => {
  expect(repo.acquireLock('summarize:/p', 'A', 120_000)).toBe(true);
  expect(repo.acquireLock('summarize:/p', 'B', 120_000)).toBe(false);
});

test('expired lock can be taken', async () => {
  expect(repo.acquireLock('summarize:/p', 'A', 1)).toBe(true);
  await sleep(5);
  expect(repo.acquireLock('summarize:/p', 'B', 120_000)).toBe(true);
  expect(repo.acquireLock('summarize:/p', 'A', 120_000)).toBe(false);
});

test('released lock can be taken; only the holder can release', () => {
  repo.acquireLock('l', 'A', 120_000);
  repo.releaseLock('l', 'B');
  expect(repo.acquireLock('l', 'B', 120_000)).toBe(false);
  repo.releaseLock('l', 'A');
  expect(repo.acquireLock('l', 'B', 120_000)).toBe(true);
});

test('the current holder can renew its lock', () => {
  expect(repo.acquireLock('l', 'A', 120_000)).toBe(true);
  expect(repo.acquireLock('l', 'A', 120_000)).toBe(true);
});

test('locks with different names are independent', () => {
  expect(repo.acquireLock('summarize:/p', 'A', 120_000)).toBe(true);
  expect(repo.acquireLock('summarize:/q', 'B', 120_000)).toBe(true);
});

test('pruneOlderThan removes old events only', () => {
  repo.insertEvents([
    ev('old1', { ts: '2026-09-01T00:00:00.000Z' }),
    ev('old2', { projectRoot: '/q', ts: '2026-09-02T00:00:00.000Z' }),
    ev('new', { ts: '2026-10-20T00:00:00.000Z' }),
  ]);
  expect(repo.pruneOlderThan('2026-10-01T00:00:00.000Z')).toBe(2);
  expect(repo.eventsSince(EPOCH).map((e) => e.dedupeKey)).toEqual(['new']);
});

test('deleteProject removes only that project (events, brief, shown marker)', () => {
  repo.insertEvents([ev('p'), ev('q', { projectRoot: '/q' })]);
  repo.saveBrief('/p', 'h', '{}', null, null);
  repo.saveBrief('/q', 'h', '{}', null, null);
  repo.markBriefShown('/p', '2026-10-20T10:00:00.000Z');
  repo.deleteProject('/p');
  expect(repo.projects().map((p) => p.root)).toEqual(['/q']);
  expect(repo.getBrief('/p')).toBeNull();
  expect(repo.getBrief('/q')).not.toBeNull();
  expect(repo.briefShownFor('/p')).toBeNull();
});

test('deleteAll removes events, briefs, shown markers and locks, but keeps cursors', () => {
  repo.insertEvents([ev('p'), ev('q', { projectRoot: '/q' })]);
  repo.saveBrief('/p', 'h', '{}', null, null);
  repo.markBriefShown('/p', '2026-10-20T10:00:00.000Z');
  repo.acquireLock('l', 'A', 120_000);
  repo.setCursor('claude', '/f.jsonl', '123');
  repo.deleteAll();
  expect(repo.projects()).toEqual([]);
  expect(repo.getBrief('/p')).toBeNull();
  expect(repo.briefShownFor('/p')).toBeNull();
  expect(repo.acquireLock('l', 'B', 120_000)).toBe(true);
  expect(repo.getCursor('claude', '/f.jsonl')).toBe('123');
});

test('transaction commits everything inside it together', () => {
  repo.transaction(() => {
    repo.insertEvents([ev('a')]);
    repo.setCursor('shell', 'k', '1');
  });
  expect(repo.eventsSince(EPOCH)).toHaveLength(1);
  expect(repo.getCursor('shell', 'k')).toBe('1');
});

test('transaction rolls back events and cursors when it throws', () => {
  expect(() =>
    repo.transaction(() => {
      repo.insertEvents([ev('a')]);
      repo.setCursor('shell', 'k', '1');
      throw new Error('crash between insert and cursor');
    }),
  ).toThrow('crash');
  expect(repo.eventsSince(EPOCH)).toEqual([]);
  expect(repo.getCursor('shell', 'k')).toBeNull();
});

test('transaction returns the value of its function', () => {
  expect(repo.transaction(() => repo.insertEvents([ev('a'), ev('b')]))).toBe(2);
});

test('lastEventTs finds the newest event by source and/or kind, or null', () => {
  expect(repo.lastEventTs({ source: 'shell' })).toBeNull();
  repo.insertEvents([
    ev('a', { source: 'shell', kind: 'command', ts: '2026-10-20T10:00:00.000Z' }),
    ev('b', { source: 'shell', kind: 'command_failed', ts: '2026-10-21T10:00:00.000Z' }),
    ev('c', { source: 'claude', kind: 'session_start', ts: '2026-10-19T10:00:00.000Z' }),
  ]);
  expect(repo.lastEventTs({ source: 'shell' })).toBe('2026-10-21T10:00:00.000Z');
  expect(repo.lastEventTs({ kind: 'session_start' })).toBe('2026-10-19T10:00:00.000Z');
  expect(repo.lastEventTs({ source: 'shell', kind: 'command' })).toBe('2026-10-20T10:00:00.000Z');
  expect(repo.lastEventTs({ source: 'codex' })).toBeNull();
});

test('countEvents counts all events, or those of one project', () => {
  repo.insertEvents([
    ev('1', { projectRoot: '/a' }),
    ev('2', { projectRoot: '/a' }),
    ev('3', { projectRoot: '/b' }),
  ]);
  expect(repo.countEvents()).toBe(3);
  expect(repo.countEvents('/a')).toBe(2);
  expect(repo.countEvents('/none')).toBe(0);
});
