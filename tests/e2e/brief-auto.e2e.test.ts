import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { openDb } from '../../src/store/db.ts';
import { createRepo } from '../../src/store/repo.ts';
import { rahulEvents } from '../brief/rahul.ts';

// Runs the built CLI (npm run test:e2e builds dist/ first — R-A6).
const CLI = resolve(import.meta.dirname, '../../dist/cli.js');
let tmp: string;
let project: string;
const savedHome = process.env.LEFTOFF_HOME;

beforeEach(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), 'leftoff-e2e-auto-')));
  project = join(tmp, 'myapp');
  mkdirSync(project);
  process.env.LEFTOFF_HOME = join(tmp, 'lhome');
});
afterEach(() => {
  if (savedHome === undefined) delete process.env.LEFTOFF_HOME;
  else process.env.LEFTOFF_HOME = savedHome;
  rmSync(tmp, { recursive: true, force: true });
});

test('real CLI: `leftoff brief --auto` prints the short brief once, then nothing', () => {
  // Rahul's events, re-dated to end 5 hours ago (past the 4 h gap).
  const events = rahulEvents(project);
  const shift = Date.now() - 5 * 3_600_000 - Date.parse(events.at(-1)?.ts as string);
  const db = openDb();
  createRepo(db).insertEvents(
    events.map((e) => ({ ...e, ts: new Date(Date.parse(e.ts) + shift).toISOString() })),
  );
  // Background ingest already "ran": the test starts no detached process.
  createRepo(db).setCursor('ingest', 'last_bg', new Date().toISOString());
  db.close();
  const run = () =>
    spawnSync(process.execPath, [CLI, 'brief', '--auto'], {
      cwd: project,
      env: {
        ...process.env,
        CLAUDE_CONFIG_DIR: join(tmp, 'claude'),
        CODEX_HOME: join(tmp, 'codex'),
        GIT_CONFIG_GLOBAL: '/dev/null',
        NO_COLOR: '1',
      },
      encoding: 'utf8',
    });
  const first = run();
  expect(first.status).toBe(0);
  expect(first.stderr).toBe('');
  const lines = first.stdout.trimEnd().split('\n');
  expect(lines[0]).toBe('Where you left off — myapp · last active 5h ago');
  expect(lines.at(-1)).toBe('Run `leftoff resume` for details');
  expect(lines).toContain('  ✗ `python scripts/send_test_email.py` — SMTP connection refused');
  expect([run().status, run().stdout]).toEqual([0, '']);
});
