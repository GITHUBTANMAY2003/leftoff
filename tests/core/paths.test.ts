import { mkdirSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { ensureHome, paths } from '../../src/core/paths.ts';

let tmp: string;
const savedHome = process.env.LEFTOFF_HOME;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'leftoff-paths-'));
  process.env.LEFTOFF_HOME = tmp;
});

afterEach(() => {
  if (savedHome === undefined) delete process.env.LEFTOFF_HOME;
  else process.env.LEFTOFF_HOME = savedHome;
  rmSync(tmp, { recursive: true, force: true });
});

test('paths honor LEFTOFF_HOME', () => {
  expect(paths().home).toBe(tmp);
  expect(paths().db).toBe(join(tmp, 'leftoff.db'));
  expect(paths().config).toBe(join(tmp, 'config.json'));
  expect(paths().shellDir).toBe(join(tmp, 'shell'));
  expect(paths().shellLog).toBe(join(tmp, 'shell', 'shell.log'));
  expect(paths().binDir).toBe(join(tmp, 'bin'));
  expect(paths().shim).toBe(join(tmp, 'bin', 'leftoff'));
  expect(paths().logDir).toBe(join(tmp, 'logs'));
  expect(paths().logFile).toBe(join(tmp, 'logs', 'leftoff.log'));
  expect(paths().tmp).toBe(join(tmp, 'tmp'));
});

test('paths default to ~/.leftoff when LEFTOFF_HOME is unset or empty', () => {
  delete process.env.LEFTOFF_HOME;
  expect(paths().home).toBe(join(homedir(), '.leftoff'));
  process.env.LEFTOFF_HOME = '';
  expect(paths().home).toBe(join(homedir(), '.leftoff'));
});

test('a relative LEFTOFF_HOME is made absolute', () => {
  process.env.LEFTOFF_HOME = 'relative/dir';
  expect(paths().home).toBe(resolve('relative/dir'));
});

test('ensureHome creates home and subdirectories with 0700', () => {
  const home = join(tmp, 'new-home');
  process.env.LEFTOFF_HOME = home;
  ensureHome();
  for (const dir of [
    home,
    join(home, 'shell'),
    join(home, 'bin'),
    join(home, 'logs'),
    join(home, 'tmp'),
  ]) {
    expect(statSync(dir).mode & 0o777).toBe(0o700);
  }
});

test('ensureHome tightens an existing home directory to 0700', () => {
  const home = join(tmp, 'loose-home');
  mkdirSync(home, { mode: 0o755 });
  process.env.LEFTOFF_HOME = home;
  ensureHome();
  expect(statSync(home).mode & 0o777).toBe(0o700);
});
