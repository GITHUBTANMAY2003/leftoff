import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { isBriefDue, runBriefAuto } from '../../src/cli/commands/brief-auto.ts';
import { DEFAULT_CONFIG, saveConfig, type Config } from '../../src/core/config.ts';
import { ensureHome } from '../../src/core/paths.ts';
import { makeEvent } from '../../src/model/event.ts';
import { openDb } from '../../src/store/db.ts';
import { createRepo, type Repo } from '../../src/store/repo.ts';
import { RAHUL_WORKING, rahulEvents } from '../brief/rahul.ts';

let tmp: string;
let project: string;
const KEYS = [
  'LEFTOFF_HOME',
  'CLAUDE_CONFIG_DIR',
  'CODEX_HOME',
  'GIT_CONFIG_GLOBAL',
  'LEFTOFF_INTERNAL',
  'LEFTOFF_QUIET',
] as const;
const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));

beforeEach(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), 'leftoff-auto-')));
  process.env.LEFTOFF_HOME = join(tmp, 'lhome');
  process.env.CLAUDE_CONFIG_DIR = join(tmp, 'claude');
  process.env.CODEX_HOME = join(tmp, 'codex');
  process.env.GIT_CONFIG_GLOBAL = '/dev/null';
  delete process.env.LEFTOFF_INTERNAL;
  delete process.env.LEFTOFF_QUIET;
  ensureHome();
  project = join(tmp, 'myapp');
  mkdirSync(project);
});

afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  rmSync(tmp, { recursive: true, force: true });
});

function withRepo<T>(fn: (repo: Repo) => T): T {
  const db = openDb();
  try {
    return fn(createRepo(db));
  } finally {
    db.close();
  }
}
const NOW = new Date('2026-10-28T09:00:00.000Z');
const HOUR = 3_600_000;
// Rahul's events, re-dated so the last one is `hoursAgo` before NOW.
function seed(hoursAgo: number): void {
  const events = rahulEvents(project);
  const shift = NOW.getTime() - hoursAgo * HOUR - Date.parse(events.at(-1)?.ts as string);
  withRepo((repo) =>
    repo.insertEvents(
      events.map((e) => ({ ...e, ts: new Date(Date.parse(e.ts) + shift).toISOString() })),
    ),
  );
}
const spawned: string[] = [];
const deps = (over: Parameters<typeof runBriefAuto>[1] = {}) => ({
  now: NOW,
  readWorking: () => RAHUL_WORKING,
  spawnIngest: () => spawned.push('ingest'),
  ...over,
});
const config = (): Config => structuredClone(DEFAULT_CONFIG) as Config;

test('due after 4h gap, not due twice', async () => {
  seed(5);
  expect(withRepo((repo) => isBriefDue(project, repo, config(), NOW))).toBe(true);
  const out = await runBriefAuto(project, deps());
  expect(out.split('\n')[0]).toBe(
    'Where you left off — myapp (feature/forgot-password) · last active 5h ago',
  );
  expect(out.split('\n').at(-1)).toBe('Run `leftoff resume` for details');
  expect(await runBriefAuto(project, deps())).toBe(''); // shown for this activity
  expect(withRepo((repo) => isBriefDue(project, repo, config(), NOW))).toBe(false);
  // Newer activity (still ≥ 4 h old) makes it due again.
  withRepo((repo) =>
    repo.insertEvents([
      makeEvent({
        source: 'shell',
        kind: 'command',
        projectRoot: project,
        ts: new Date(NOW.getTime() - 4.5 * HOUR).toISOString(),
        sessionRef: 'shell:1',
        summary: 'make',
        data: { command: 'make' },
        dedupeKey: 'later-activity',
      }),
    ]),
  );
  expect(withRepo((repo) => isBriefDue(project, repo, config(), NOW))).toBe(true);
});

test('not due before the gap, or without any activity', async () => {
  expect(withRepo((repo) => isBriefDue(project, repo, config(), NOW))).toBe(false);
  expect(await runBriefAuto(project, deps())).toBe('');
  seed(3.9);
  expect(withRepo((repo) => isBriefDue(project, repo, config(), NOW))).toBe(false);
  const fiveHoursLater = new Date(NOW.getTime() + 5 * HOUR);
  expect(withRepo((repo) => isBriefDue(project, repo, config(), fiveHoursLater))).toBe(true);
});

test('not due when LEFTOFF_QUIET=1 or autoBrief.enabled=false', async () => {
  seed(5);
  process.env.LEFTOFF_QUIET = '1';
  expect(withRepo((repo) => isBriefDue(project, repo, config(), NOW))).toBe(false);
  expect(await runBriefAuto(project, deps())).toBe('');
  delete process.env.LEFTOFF_QUIET;
  const off = config();
  off.autoBrief.enabled = false;
  expect(withRepo((repo) => isBriefDue(project, repo, off, NOW))).toBe(false);
  saveConfig(off);
  expect(await runBriefAuto(project, deps())).toBe('');
  const gap = config();
  gap.autoBrief.gapHours = 6;
  expect(withRepo((repo) => isBriefDue(project, repo, gap, NOW))).toBe(false);
});

test('quiet and disabled only stop the printing: the background ingest still starts (owner decision after Task 14)', async () => {
  seed(5);
  spawned.length = 0;
  process.env.LEFTOFF_QUIET = '1';
  expect(await runBriefAuto(project, deps())).toBe('');
  expect(spawned).toEqual(['ingest']);
  delete process.env.LEFTOFF_QUIET;
  // The quiet run did not use up the brief: it is still due afterwards.
  withRepo((repo) => repo.setCursor('ingest', 'last_bg', '2000-01-01T00:00:00.000Z'));
  const off = config();
  off.autoBrief.enabled = false;
  saveConfig(off);
  expect(await runBriefAuto(project, deps())).toBe('');
  expect(spawned).toEqual(['ingest', 'ingest']);
  saveConfig(config());
  expect(await runBriefAuto(project, deps())).not.toBe('');
});

test('LEFTOFF_INTERNAL=1 starts no ingest either', async () => {
  spawned.length = 0;
  process.env.LEFTOFF_INTERNAL = '1';
  await runBriefAuto(project, deps());
  expect(spawned).toEqual([]);
});

test('runBriefAuto returns "" when over budget, and the brief stays due', async () => {
  seed(5);
  const slowGit = () => {
    const until = Date.now() + 400;
    while (Date.now() < until); // git status taking 400 ms
    return RAHUL_WORKING;
  };
  expect(await runBriefAuto(project, deps({ readWorking: slowGit }))).toBe('');
  expect(await runBriefAuto(project, deps())).not.toBe('');
});

test('LEFTOFF_INTERNAL=1, a project inside LEFTOFF_HOME, or an ignored project → ""', async () => {
  seed(5);
  process.env.LEFTOFF_INTERNAL = '1';
  expect(await runBriefAuto(project, deps())).toBe('');
  delete process.env.LEFTOFF_INTERNAL;
  expect(await runBriefAuto(join(tmp, 'lhome', 'tmp'), deps())).toBe('');
  const c = config();
  c.ignore.projects = [project];
  saveConfig(c);
  expect(await runBriefAuto(project, deps())).toBe('');
});

test('starts the background ingest (rate-limited) even when no brief is due', async () => {
  spawned.length = 0;
  await runBriefAuto(project, deps());
  await runBriefAuto(project, deps());
  expect(spawned).toEqual(['ingest']);
});

test('`leftoff brief --auto` prints nothing without activity, exits 0, and is hidden', () => {
  const cli = resolve(import.meta.dirname, '../../src/cli/index.ts');
  const run = (args: string[]) =>
    spawnSync(process.execPath, [cli, ...args], {
      cwd: project,
      env: process.env,
      encoding: 'utf8',
    });
  withRepo((repo) => repo.setCursor('ingest', 'last_bg', new Date().toISOString())); // no background ingest from a test
  const r = run(['brief', '--auto']);
  expect([r.status, r.stdout, r.stderr]).toEqual([0, '', '']);
  expect(run(['--help']).stdout).not.toMatch(/\bbrief\b/);
});
