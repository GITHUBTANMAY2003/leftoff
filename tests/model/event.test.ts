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
])('normalizeCommand(%j) → %j', (input, expected) =>
  expect(normalizeCommand(input)).toBe(expected),
);
