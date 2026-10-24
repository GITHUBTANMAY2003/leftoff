import { mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { logError, readRecentErrors } from '../../src/core/logger.ts';
import { ensureHome, paths } from '../../src/core/paths.ts';

let tmp: string;
const savedHome = process.env.LEFTOFF_HOME;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'leftoff-logger-'));
  process.env.LEFTOFF_HOME = tmp;
  ensureHome();
});

afterEach(() => {
  if (savedHome === undefined) delete process.env.LEFTOFF_HOME;
  else process.env.LEFTOFF_HOME = savedHome;
  rmSync(tmp, { recursive: true, force: true });
});

test('logError appends one line with timestamp, scope and message', () => {
  logError('ingest', new Error('boom'));
  logError('config', 'bad value');
  const lines = readRecentErrors(5);
  expect(lines).toHaveLength(2);
  expect(lines[0]).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z \[ingest\] .*boom/);
  expect(lines[1]).toMatch(/\[config\] bad value$/);
});

test('readRecentErrors returns the last n lines, oldest first', () => {
  for (const n of [1, 2, 3, 4]) logError('t', `e${n}`);
  expect(readRecentErrors(2).map((l) => l.slice(-2))).toEqual(['e3', 'e4']);
});

test('a multi-line error (stack trace) is stored as a single line', () => {
  logError('t', new Error('first\nsecond'));
  logError('t', 'after');
  expect(readRecentErrors(5)).toHaveLength(2);
});

test('readRecentErrors returns [] when there is no log yet', () => {
  expect(readRecentErrors(5)).toEqual([]);
});

test('log file is created with mode 0600', () => {
  logError('t', 'x');
  expect(statSync(paths().logFile).mode & 0o777).toBe(0o600);
});

test('log rotates at 1 MB keeping 2 files', () => {
  const big = 'x'.repeat(10_000);
  for (let i = 0; i < 250; i++) logError('t', big); // ~2.5 MB in total → rotates more than once
  expect(readdirSync(paths().logDir).sort()).toEqual(['leftoff.log', 'leftoff.log.1']);
  expect(statSync(paths().logFile).size).toBeLessThanOrEqual(1024 * 1024);
});

test('readRecentErrors also reads the rotated file when the current one is short', () => {
  writeFileSync(paths().logFile + '.1', 'old-1\nold-2\n');
  writeFileSync(paths().logFile, 'new-1\n');
  expect(readRecentErrors(3)).toEqual(['old-1', 'old-2', 'new-1']);
  expect(readRecentErrors(2)).toEqual(['old-2', 'new-1']);
});

test('logError never throws, even when the log cannot be written', () => {
  const notADir = join(tmp, 'file');
  writeFileSync(notADir, '');
  process.env.LEFTOFF_HOME = notADir;
  expect(() => logError('t', 'x')).not.toThrow();
});
