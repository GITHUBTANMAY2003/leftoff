import { afterEach, beforeEach, expect, test } from 'vitest';
import { parseSince, relativeAgo } from '../../src/core/time.ts';

const savedTz = process.env.TZ;
beforeEach(() => {
  process.env.TZ = 'Asia/Kolkata'; // UTC+05:30: local midnight ≠ UTC midnight
});
afterEach(() => {
  if (savedTz === undefined) delete process.env.TZ;
  else process.env.TZ = savedTz;
});

const now = new Date('2026-10-21T08:30:00.000Z'); // 14:00 local

test.each([
  ['2026-10-21T08:29:30.000Z', 'just now'], // 30 s
  ['2026-10-21T08:30:10.000Z', 'just now'], // a little in the future (clock skew)
  ['2026-10-21T08:29:00.000Z', '1m ago'],
  ['2026-10-21T07:31:00.000Z', '59m ago'],
  ['2026-10-21T07:30:00.000Z', '1h ago'],
  ['2026-10-20T18:30:00.000Z', '14h ago'], // §1.1
  ['2026-10-20T08:31:00.000Z', '23h ago'],
  ['2026-10-20T08:30:00.000Z', '1d ago'],
  ['2026-10-17T08:30:00.000Z', '4d ago'],
])('relativeAgo(%s) → %s', (iso, expected) => {
  expect(relativeAgo(iso, now)).toBe(expected);
});

test('parseSince: today and yesterday are local midnights', () => {
  expect(parseSince('today', now).toISOString()).toBe('2026-10-20T18:30:00.000Z'); // 21 Oct 00:00 IST
  expect(parseSince('yesterday', now).toISOString()).toBe('2026-10-19T18:30:00.000Z');
});

test('parseSince: Nh is N hours before now', () => {
  expect(parseSince('6h', now).toISOString()).toBe('2026-10-21T02:30:00.000Z');
  expect(parseSince('0h', now).toISOString()).toBe(now.toISOString());
});

test('parseSince: YYYY-MM-DD is that local date at midnight', () => {
  expect(parseSince('2026-10-18', now).toISOString()).toBe('2026-10-17T18:30:00.000Z');
});

test.each(['last week', '2026-02-30', '6', '-3h', '2026/10/18', ''])(
  'parseSince rejects %j with a hint',
  (s) => {
    expect(() => parseSince(s, now)).toThrow(/yesterday, today, Nh or YYYY-MM-DD/);
  },
);
