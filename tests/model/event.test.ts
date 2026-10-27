import { expect, test } from 'vitest';
import { dedupeKey, makeEvent, normalizeCommand } from '../../src/model/event.ts';

const base = {
  source: 'shell' as const,
  kind: 'command' as const,
  projectRoot: '/p',
  ts: '2026-10-20T10:00:00.000Z',
  sessionRef: 'shell:1',
  dedupeKey: 'k',
};

test('dedupeKey is the sha1 hex of the parts joined by NUL', () => {
  // sha1("claude\u0000/f.jsonl\u000012\u00000"), computed independently with `shasum`.
  expect(dedupeKey('claude', '/f.jsonl', 12, 0)).toBe('56315c881e890f536e0715035683f434a816186a');
});

test('dedupeKey keeps part boundaries: ("a","bc") differs from ("ab","c")', () => {
  expect(dedupeKey('a', 'bc')).not.toBe(dedupeKey('ab', 'c'));
});

test('makeEvent passes identity fields through and defaults data to {}', () => {
  expect(makeEvent({ ...base, summary: 'npm test' })).toEqual({
    ...base,
    summary: 'npm test',
    data: {},
  });
});

test('makeEvent redacts summary and data', () => {
  const e = makeEvent({
    ...base,
    summary: 'export GH_TOKEN=abc123',
    data: { cwd: '/p', output: 'psql postgres://admin:hunter2@db/x', password: 'hunter2' },
  });
  expect(e.summary).toBe('export GH_TOKEN=[REDACTED]');
  expect(e.data).toEqual({
    cwd: '/p',
    output: 'psql postgres://admin:[REDACTED]@db/x',
    password: '[REDACTED]',
  });
});

test('makeEvent truncates summary to 300 chars ending with …', () => {
  const e = makeEvent({ ...base, summary: 'x'.repeat(301) });
  expect(e.summary).toBe('x'.repeat(299) + '…');
  expect(makeEvent({ ...base, summary: 'y'.repeat(300) }).summary).toBe('y'.repeat(300));
});

test('makeEvent counts characters, not UTF-16 units, and never splits an emoji', () => {
  const e = makeEvent({ ...base, summary: '😀'.repeat(301) });
  expect(Array.from(e.summary)).toHaveLength(300);
  expect(e.summary.endsWith('😀…')).toBe(true);
});

test('makeEvent shrinks data to ≤ 4096 bytes by dropping the largest string fields first', () => {
  const e = makeEvent({
    ...base,
    summary: 's',
    data: { exitCode: 1, cwd: '/p', output: 'o'.repeat(5000), error: 'e'.repeat(3000) },
  });
  expect(e.data).toEqual({ exitCode: 1, cwd: '/p', error: 'e'.repeat(3000), truncated: true });
  expect(Buffer.byteLength(JSON.stringify(e.data))).toBeLessThanOrEqual(4096);
});

test('makeEvent measures data in bytes (multi-byte characters count more)', () => {
  // 1500 × "é" = 3000 bytes in UTF-8 but only 1500 UTF-16 units.
  const e = makeEvent({
    ...base,
    summary: 's',
    data: { a: 'é'.repeat(1500), b: 'é'.repeat(1500) },
  });
  expect(Object.keys(e.data).sort()).toEqual(['b', 'truncated']);
});

test('makeEvent falls back to { truncated: true } when no string field is left to drop', () => {
  const e = makeEvent({
    ...base,
    summary: 's',
    data: { list: Array.from({ length: 2000 }, (_, i) => i) },
  });
  expect(e.data).toEqual({ truncated: true });
});

test('makeEvent leaves small data untouched (no truncated flag)', () => {
  expect(makeEvent({ ...base, summary: 's', data: { a: 'x' } }).data).toEqual({ a: 'x' });
});

test('normalizeCommand strips env assignments', () =>
  expect(normalizeCommand('  FOO=1  npm   test ')).toBe('npm test'));

test.each([
  ['FOO=1 BAR="a b" npm test', 'npm test'],
  ["A='x' make", 'make'],
  ['npm test -- --grep=foo', 'npm test -- --grep=foo'],
  ['FOO=1', 'FOO=1'], // a bare assignment is the command itself
  ['\tgit\n status ', 'git status'],
  // Redirections, a leading `cd <dir> &&` and trailing output-trimming pipes
  // are stripped (owner decision after Task 11).
  ['npm run lint 2>&1', 'npm run lint'],
  ['npm test >/dev/null', 'npm test'],
  ['npm test 2>/dev/null', 'npm test'],
  ['npm test &>/dev/null', 'npm test'],
  ['npm test > /dev/null 2>&1', 'npm test'],
  ['make build >build.log', 'make build'],
  ['make build >> build.log', 'make build'],
  ['cd /x && npm test', 'npm test'],
  ['cd "/my dir" && cd sub && FOO=1 npm test', 'npm test'],
  ['npm test 2>&1 | tail -20', 'npm test'],
  ['npm test | head -n 5 | cat', 'npm test'],
  ['git log | less', 'git log'],
  ['cd /x && npm test 2>&1 | tail -5', 'npm test'],
  ['echo "a > b"', 'echo "a > b"'], // inside quotes: not a redirection
  ["grep 'x | tail' f", "grep 'x | tail' f"],
  ['npm test | grep fail', 'npm test | grep fail'], // only trimming pipes are stripped
  ['cd /x', 'cd /x'], // a lone cd is the command itself
  ['make 2>&1 build', 'make build'], // 2>&1 has no file after it
  ['npm test | cat -A', 'npm test | cat -A'], // cat and less only when bare
  ['cd /x; npm test', 'cd /x; npm test'], // only `cd <dir> &&` is stripped
])('normalizeCommand(%j) → %j', (input, expected) =>
  expect(normalizeCommand(input)).toBe(expected),
);
