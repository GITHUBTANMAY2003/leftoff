import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { copyToClipboard, defaultSince, runStandup } from '../../src/cli/commands/standup.ts';
import { ensureHome } from '../../src/core/paths.ts';
import { makeEvent } from '../../src/model/event.ts';
import { openDb } from '../../src/store/db.ts';
import { createRepo } from '../../src/store/repo.ts';
import { rahulEvents } from '../brief/rahul.ts';

let tmp: string;
let project: string;
const KEYS = [
  'LEFTOFF_HOME',
  'CLAUDE_CONFIG_DIR',
  'CODEX_HOME',
  'GIT_CONFIG_GLOBAL',
  'PATH',
  'TZ',
] as const;
const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));

beforeEach(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), 'leftoff-standup-')));
  // Never read the developer's real agent logs or git config in tests.
  process.env.LEFTOFF_HOME = join(tmp, 'lhome');
  process.env.CLAUDE_CONFIG_DIR = join(tmp, 'claude');
  process.env.CODEX_HOME = join(tmp, 'codex');
  process.env.GIT_CONFIG_GLOBAL = '/dev/null';
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

function seed(events = rahulEvents(project)): void {
  const db = openDb();
  createRepo(db).insertEvents(events);
  db.close();
}

const local = (y: number, m: number, d: number, h = 0) => new Date(y, m - 1, d, h);

test('default since is the start of the previous local day', () => {
  process.env.TZ = 'Asia/Kolkata'; // UTC+05:30: local midnight ≠ UTC midnight
  expect(defaultSince(local(2026, 10, 21, 9))).toEqual(local(2026, 10, 20)); // Wednesday
  expect(defaultSince(local(2026, 10, 23, 0))).toEqual(local(2026, 10, 22)); // Friday 00:00
  expect(defaultSince(local(2026, 10, 25, 11))).toEqual(local(2026, 10, 24)); // Sunday
});

test('Monday since covers Friday', () => {
  process.env.TZ = 'Asia/Kolkata';
  expect(defaultSince(local(2026, 10, 26, 9))).toEqual(local(2026, 10, 23));
  expect(defaultSince(local(2026, 10, 26, 9)).getDay()).toBe(5);
});

test('standup for the project of cwd, with an explicit --since', async () => {
  seed();
  const r = await runStandup({ cwd: project, since: '2026-10-20', all: false, copy: false });
  expect(r.exitCode).toBe(0);
  expect(r.output).toBe(
    `Yesterday:
- Built POST /auth/forgot-password endpoint
- Added reset-token migration
Today:
- Resolve: \`python scripts/send_test_email.py\` — SMTP connection refused
Blockers:
- \`python scripts/send_test_email.py\` — SMTP connection refused`,
  );
});

test('work before --since is not in Yesterday', async () => {
  seed();
  const r = await runStandup({ cwd: project, since: 'today', all: false, copy: false });
  expect(r.output.split('\n').slice(0, 2)).toEqual([
    'Yesterday:',
    '- No activity recorded in this period',
  ]);
});

test('--all covers every project active since then, prefixed with its name', async () => {
  const api = join(tmp, 'api');
  mkdirSync(api);
  seed([
    ...rahulEvents(project),
    makeEvent({
      source: 'git',
      kind: 'commit',
      projectRoot: api,
      ts: '2026-10-20T12:00:00.000Z',
      sessionRef: null,
      summary: 'Add health check',
      data: { hash: 'abc1234' },
      dedupeKey: 'api-1',
    }),
  ]);
  const elsewhere = join(tmp, 'elsewhere');
  mkdirSync(elsewhere);
  const r = await runStandup({ cwd: elsewhere, since: '2026-10-20', all: true, copy: false });
  expect(r.output).toContain('- myapp: Built POST /auth/forgot-password endpoint');
  expect(r.output).toContain('- api: Add health check');
});

test('an invalid --since is refused with a hint', async () => {
  await expect(
    runStandup({ cwd: project, since: 'last week', all: false, copy: false }),
  ).rejects.toThrow(/since/i);
});

function fakeTool(dir: string, name: string, out: string, exitCode = 0): void {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, name);
  writeFileSync(
    file,
    `#!/bin/sh\necho "$@" > '${out}.args'\n/bin/cat > '${out}'\nexit ${exitCode}\n`,
  );
  chmodSync(file, 0o755);
}

test('--copy uses pbcopy when present and says "(copied)"', async () => {
  const bin = join(tmp, 'bin');
  fakeTool(bin, 'pbcopy', join(tmp, 'clip'));
  process.env.PATH = bin;
  seed();
  const r = await runStandup({ cwd: project, since: '2026-10-20', all: false, copy: true });
  expect(r.output.endsWith('\n(copied)')).toBe(true);
  expect(readFileSync(join(tmp, 'clip'), 'utf8')).toBe(r.output.replace(/\n\(copied\)$/, ''));
});

test('clipboard tools are tried in order: pbcopy, wl-copy, xclip', () => {
  const bin = join(tmp, 'bin');
  fakeTool(bin, 'pbcopy', join(tmp, 'pb'), 1); // present but failing (e.g. no pasteboard)
  fakeTool(bin, 'xclip', join(tmp, 'xclip'));
  process.env.PATH = bin;
  expect(copyToClipboard('hello')).toBe('(copied)');
  expect(readFileSync(join(tmp, 'xclip'), 'utf8')).toBe('hello');
  expect(readFileSync(join(tmp, 'xclip.args'), 'utf8')).toBe('-selection clipboard\n');
});

test('--copy without any clipboard tool says so', () => {
  process.env.PATH = join(tmp, 'empty-bin');
  expect(copyToClipboard('hello')).toBe('(clipboard tool not found)');
});
