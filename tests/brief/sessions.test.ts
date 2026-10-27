import { expect, test } from 'vitest';
import { splitSessions } from '../../src/brief/sessions.ts';
import { makeEvent, type WorkEvent } from '../../src/model/event.ts';

const at = (iso: string, key = iso): WorkEvent =>
  makeEvent({
    source: 'shell',
    kind: 'command',
    projectRoot: '/p',
    ts: iso,
    sessionRef: null,
    summary: key,
    dedupeKey: key,
  });

test('splits on 45 min gap', () => {
  const events = [
    at('2026-10-20T10:00:00.000Z'),
    at('2026-10-20T10:44:59.000Z'), // 44:59 later: same session
    at('2026-10-20T11:29:59.000Z'), // exactly 45:00 later: new session
    at('2026-10-20T11:30:00.000Z'),
  ];
  expect(splitSessions(events, 45).map((s) => s.map((e) => e.ts))).toEqual([
    ['2026-10-20T10:00:00.000Z', '2026-10-20T10:44:59.000Z'],
    ['2026-10-20T11:29:59.000Z', '2026-10-20T11:30:00.000Z'],
  ]);
});

test('the gap is measured between consecutive events, not from the session start', () => {
  const events = ['10:00', '10:40', '11:20', '12:00'].map((t) => at(`2026-10-20T${t}:00.000Z`));
  expect(splitSessions(events, 45)).toHaveLength(1);
});

test('unsorted input is sorted by time first', () => {
  const events = [at('2026-10-20T12:00:00.000Z', 'late'), at('2026-10-20T10:00:00.000Z', 'early')];
  expect(splitSessions(events, 45).map((s) => s.map((e) => e.summary))).toEqual([
    ['early'],
    ['late'],
  ]);
});

test('no events → no sessions; gapMinutes may be decimal', () => {
  expect(splitSessions([], 45)).toEqual([]);
  const events = [at('2026-10-20T10:00:00.000Z'), at('2026-10-20T10:00:40.000Z')];
  expect(splitSessions(events, 0.5)).toHaveLength(2); // 40 s ≥ 30 s
});
