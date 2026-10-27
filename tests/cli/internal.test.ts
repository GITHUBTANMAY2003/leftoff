import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { ensureHome } from '../../src/core/paths.ts';
import { openDb } from '../../src/store/db.ts';
import { createRepo } from '../../src/store/repo.ts';

let tmp: string;
const KEYS = ['LEFTOFF_HOME', 'CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'GIT_CONFIG_GLOBAL'] as const;
const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));

beforeEach(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), 'leftoff-internal-')));
  process.env.LEFTOFF_HOME = join(tmp, 'lhome');
  process.env.CLAUDE_CONFIG_DIR = join(tmp, 'claude');
  process.env.CODEX_HOME = join(tmp, 'codex');
  process.env.GIT_CONFIG_GLOBAL = '/dev/null';
  ensureHome();
});

afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  rmSync(tmp, { recursive: true, force: true });
});

test('`leftoff internal summarize --project` runs silently, exits 0, and is hidden from help', () => {
  const project = join(tmp, 'myapp');
  mkdirSync(project);
  const cli = resolve(import.meta.dirname, '../../src/cli/index.ts');
  const run = (args: string[]) =>
    spawnSync(process.execPath, [cli, ...args], { cwd: tmp, env: process.env, encoding: 'utf8' });
  const r = run(['internal', 'summarize', '--project', project]);
  expect(r.status).toBe(0);
  expect(r.stdout).toBe('');
  expect(r.stderr).toBe('');
  // It ingested: the ingest report was stored.
  const db = openDb();
  expect(createRepo(db).getCursor('ingest', 'last_report')).not.toBeNull();
  db.close();
  expect(run(['--help']).stdout).not.toMatch(/internal/);
});

test('`leftoff internal ingest` runs silently, exits 0, and stores the ingest report', () => {
  const cli = resolve(import.meta.dirname, '../../src/cli/index.ts');
  const r = spawnSync(process.execPath, [cli, 'internal', 'ingest'], {
    cwd: tmp,
    env: process.env,
    encoding: 'utf8',
  });
  expect([r.status, r.stdout, r.stderr]).toEqual([0, '', '']);
  const db = openDb();
  expect(createRepo(db).getCursor('ingest', 'last_report')).not.toBeNull();
  db.close();
});
