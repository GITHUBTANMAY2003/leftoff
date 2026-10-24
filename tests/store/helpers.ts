import type { WorkEvent } from '../../src/model/event.ts';

export function ev(dedupeKey: string, overrides: Partial<WorkEvent> = {}): WorkEvent {
  return {
    source: 'shell',
    kind: 'command',
    projectRoot: '/p',
    ts: '2026-10-20T10:00:00.000Z',
    sessionRef: 'shell:1',
    summary: `event ${dedupeKey}`,
    data: { exitCode: 0 },
    dedupeKey,
    ...overrides,
  };
}
