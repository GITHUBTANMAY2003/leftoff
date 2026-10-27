import type { WorkEvent } from '../model/event.ts';

// A work session (P6): consecutive events with no gap of gapMinutes or more.
export function splitSessions(events: WorkEvent[], gapMinutes: number): WorkEvent[][] {
  const sorted = [...events].sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
  const gapMs = gapMinutes * 60_000;
  const sessions: WorkEvent[][] = [];
  let previous: number | null = null;
  for (const event of sorted) {
    const t = Date.parse(event.ts);
    if (previous === null || t - previous >= gapMs) sessions.push([]);
    (sessions.at(-1) as WorkEvent[]).push(event);
    previous = t;
  }
  return sessions;
}
