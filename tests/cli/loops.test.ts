import { spawnSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { runLoops } from '../../src/cli/commands/loops.ts';
import { ensureHome } from '../../src/core/paths.ts';
import { openDb } from '../../src/store/db.ts';
import { createRepo } from '../../src/store/repo.ts';
import { rahulEvents } from '../brief/rahul.ts';
import { initRepo } from '../helpers/git.ts';

let tmp: string;
const KEYS = ['LEFTOFF_HOME', 'CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'GIT_CONFIG_GLOBAL'] as const;
const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));

beforeEach(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), 'leftoff-loops-')));
  // Never read the developer's real agent logs or git config in tests.
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

// Rahul's events, re-dated to end one hour ago so they are inside retentionDays.
function seedRahul(root: string): void {
  const events = rahulEvents(root);
  const shift = Date.now() - 3_600_000 - Date.parse(events.at(-1)?.ts as string);
  const db = openDb();
  createRepo(db).insertEvents(
    events.map((e) => ({ ...e, ts: new Date(Date.parse(e.ts) + shift).toISOString() })),
  );
  db.close();
}

test('loops lists a project with an open problem and uncommitted work', async () => {
  const app = initRepo(tmp, 'myapp', 'feature/forgot-password');
  writeFileSync(join(app, 'email_service.py'), 'x\n');
  seedRahul(app);
  const r = await runLoops({ json: false });
  expect(r.exitCode).toBe(0);
  expect(r.output).toBe(
    [
      'Loose ends across 1 project',
      '',
      'myapp (feature/forgot-password) · 1h ago',
      '  ✗ `python scripts/send_test_email.py` — SMTP connection refused (2 attempts)',
      '  • 1 uncommitted file',
      '',
      'Run `leftoff resume` inside a project for details',
    ].join('\n'),
  );
});

test('loops --json prints the loose ends as JSON', async () => {
  const app = initRepo(tmp, 'myapp');
  seedRahul(app);
  const parsed = JSON.parse((await runLoops({ json: true })).output);
  expect(parsed).toHaveLength(1);
  expect(parsed[0]).toMatchObject({ project: { root: app, name: 'myapp' }, uncommittedCount: 0 });
  expect(parsed[0].openProblems[0].error).toBe('SMTP connection refused');
});

test('loops with nothing tracked says there are no loose ends', async () => {
  expect((await runLoops({ json: false })).output).toBe(
    'No loose ends. Everything is committed and passing.',
  );
});

test('bare `leftoff` runs loops', () => {
  const app = initRepo(tmp, 'myapp');
  seedRahul(app);
  const cli = resolve(import.meta.dirname, '../../src/cli/index.ts');
  const run = (args: string[]) =>
    spawnSync(process.execPath, [cli, ...args], { cwd: tmp, env: process.env, encoding: 'utf8' });
  const bare = run([]);
  expect(bare.status).toBe(0);
  expect(bare.stdout).toMatch(/^Loose ends across 1 project\n/);
  expect(bare.stdout).toBe(run(['loops']).stdout);
  expect(JSON.parse(run(['loops', '--json']).stdout)).toHaveLength(1);
});
