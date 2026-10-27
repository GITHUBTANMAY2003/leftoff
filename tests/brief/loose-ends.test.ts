import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Database } from 'better-sqlite3';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { buildLooseEnds } from '../../src/brief/loose-ends.ts';
import type { WorkingState } from '../../src/collectors/git.ts';
import { DEFAULT_CONFIG, type Config } from '../../src/core/config.ts';
import { makeEvent, type EventKind, type WorkEvent } from '../../src/model/event.ts';
import { openDb } from '../../src/store/db.ts';
import { createRepo, type Repo } from '../../src/store/repo.ts';

const NOW = new Date('2026-10-27T09:00:00.000Z');
const HOUR = 3_600_000;
let tmp: string;
let db: Database;
let repo: Repo;
let config: Config;
let working: Record<string, WorkingState>;
let gitReads: string[];

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'leftoff-loose-'));
  db = openDb(join(tmp, 'leftoff.db'));
  repo = createRepo(db);
  config = structuredClone(DEFAULT_CONFIG) as Config;
  working = {};
  gitReads = [];
});

afterEach(() => {
  db.close();
  rmSync(tmp, { recursive: true, force: true });
});

let seq = 0;
function ev(
  root: string,
  hoursAgo: number,
  kind: EventKind,
  summary: string,
  data: Record<string, unknown> = {},
): WorkEvent {
  return makeEvent({
    source: kind === 'commit' ? 'git' : 'claude',
    kind,
    projectRoot: root,
    ts: new Date(NOW.getTime() - hoursAgo * HOUR).toISOString(),
    sessionRef: 's',
    summary,
    data,
    dedupeKey: `le-${seq++}`,
  });
}
const failure = (root: string, hoursAgo: number, command: string) =>
  ev(root, hoursAgo, 'command_failed', `\`${command}\` failed`, {
    command,
    exitCode: 1,
    error: `${command} broke`,
  });
const uncommitted = (root: string, n: number) => {
  working[root] = {
    branch: 'main',
    files: Array.from({ length: n }, (_, i) => ({ path: `f${i}.ts`, status: 'modified' })),
    diffStat: null,
  };
};

const build = (over: { deadline?: number } = {}) =>
  buildLooseEnds({
    repo,
    config,
    now: NOW,
    readWorking: (root: string) => {
      gitReads.push(root);
      return working[root] ?? { branch: null, files: [], diffStat: null };
    },
    ...over,
  });

test('loose ends: ordering is claimedDone, open problems, stale, oldest', () => {
  repo.insertEvents([
    // /claimed: one problem, and the agent claimed done after it.
    failure('/claimed', 5, 'npm test'),
    ev('/claimed', 4, 'agent_message', 'All tests pass.'),
    // /two: two problems. /one: one problem.
    failure('/two', 2, 'make a'),
    failure('/two', 2, 'make b'),
    failure('/one', 1, 'make c'),
    // /stale: uncommitted for 4 days. /fresh-old and /fresh-new: uncommitted, recent.
    ev('/stale', 96, 'command', 'ls', { command: 'ls', exitCode: 0 }),
    ev('/fresh-old', 30, 'command', 'ls', { command: 'ls', exitCode: 0 }),
    ev('/fresh-new', 3, 'command', 'ls', { command: 'ls', exitCode: 0 }),
    // /no-git: older than /stale, but not stale (no known uncommitted files).
    ev('/no-git', 100, 'command', 'ls', { command: 'ls', exitCode: 0 }),
  ]);
  for (const root of ['/stale', '/fresh-old', '/fresh-new']) uncommitted(root, 1);
  working['/no-git'] = { branch: null, files: [], diffStat: null, unavailable: true };
  expect(build().map((l) => l.project.root)).toEqual([
    '/claimed',
    '/two',
    '/one',
    '/stale',
    '/no-git',
    '/fresh-old',
    '/fresh-new',
  ]);
});

test('loose ends: each entry carries the facts the view needs', () => {
  repo.insertEvents([failure('/app', 5, 'npm test'), ev('/app', 4, 'agent_message', 'Done!')]);
  uncommitted('/app', 2);
  const [entry] = build();
  expect(entry).toMatchObject({
    project: { root: '/app', name: 'app' },
    branch: 'main',
    lastActiveAt: new Date(NOW.getTime() - 4 * HOUR).toISOString(),
    stale: false,
    uncommittedCount: 2,
    gitUnavailable: false,
  });
  expect(entry?.claimedDone?.message).toBe('Done!');
  expect(entry?.openProblems.map((p) => p.command)).toEqual(['npm test']);
});

test('stale means uncommitted files and last activity at least looseEnds.staleDays ago', () => {
  repo.insertEvents([
    ev('/a', 72, 'command', 'ls', { command: 'ls', exitCode: 0 }), // exactly 3 days
    ev('/b', 71, 'command', 'ls', { command: 'ls', exitCode: 0 }),
    failure('/c', 100, 'make'), // old, but nothing uncommitted
  ]);
  uncommitted('/a', 1);
  uncommitted('/b', 1);
  const byRoot = Object.fromEntries(build().map((l) => [l.project.root, l.stale]));
  expect(byRoot).toEqual({ '/a': true, '/b': false, '/c': false });
  config.looseEnds.staleDays = 2;
  expect(build().find((l) => l.project.root === '/b')?.stale).toBe(true);
});

test('loose ends: clean projects are omitted; none left → empty list', () => {
  repo.insertEvents([
    ev('/clean', 1, 'commit', 'Ship it', { hash: 'abc' }),
    failure('/fixed', 2, 'npm test'),
    ev('/fixed', 1, 'command', 'npm test', { command: 'npm test', exitCode: 0 }),
  ]);
  expect(build()).toEqual([]);
});

test('loose ends: only maxProjects most recent projects are checked', () => {
  config.looseEnds.maxProjects = 2;
  repo.insertEvents([
    failure('/oldest', 30, 'make'),
    failure('/middle', 20, 'make'),
    failure('/newest', 10, 'make'),
  ]);
  expect(build().map((l) => l.project.root)).toEqual(['/middle', '/newest']);
  expect(gitReads.sort()).toEqual(['/middle', '/newest']);
});

test('projects with no events in the last retentionDays are not checked', () => {
  config.retentionDays = 1;
  repo.insertEvents([failure('/old', 30, 'make'), failure('/recent', 2, 'make')]);
  expect(build().map((l) => l.project.root)).toEqual(['/recent']);
});

test('a project whose git status is unavailable is kept and marked', () => {
  repo.insertEvents([ev('/broken', 1, 'command', 'ls', { command: 'ls', exitCode: 0 })]);
  working['/broken'] = { branch: null, files: [], diffStat: null, unavailable: true };
  expect(build()).toMatchObject([
    { project: { root: '/broken' }, gitUnavailable: true, uncommittedCount: 0 },
  ]);
});

test('past the deadline, git is not read and the remaining projects are marked unavailable', () => {
  repo.insertEvents([ev('/a', 1, 'command', 'ls', { command: 'ls', exitCode: 0 })]);
  uncommitted('/a', 1);
  const [entry] = build({ deadline: Date.now() - 1 });
  expect(gitReads).toEqual([]);
  expect(entry).toMatchObject({ project: { root: '/a' }, gitUnavailable: true });
});
