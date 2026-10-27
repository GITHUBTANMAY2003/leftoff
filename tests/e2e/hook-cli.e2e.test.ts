import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, expect, test } from 'vitest';

// Runs the built CLI (npm run test:e2e builds dist/ first — R-A6).
const CLI = resolve(import.meta.dirname, '../../dist/cli.js');
let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'leftoff-e2e-hook-'));
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

const env = () => ({
  ...process.env,
  LEFTOFF_HOME: join(tmp, 'lhome'),
  CLAUDE_CONFIG_DIR: join(tmp, 'claude'),
  CODEX_HOME: join(tmp, 'codex'),
  GIT_CONFIG_GLOBAL: '/dev/null',
});

test('real CLI: `leftoff hook claude-stop` exits 0 with empty stdout on empty stdin', () => {
  const r = spawnSync(process.execPath, [CLI, 'hook', 'claude-stop'], {
    env: env(),
    input: '',
    encoding: 'utf8',
  });
  expect([r.status, r.stdout, r.stderr]).toEqual([0, '', '']);
});

test('real CLI: an unknown hook name also exits 0 silently', () => {
  const r = spawnSync(process.execPath, [CLI, 'hook', 'no-such-hook'], {
    env: env(),
    input: '{}',
    encoding: 'utf8',
  });
  expect([r.status, r.stdout, r.stderr]).toEqual([0, '', '']);
});
