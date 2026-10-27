import { expect, test } from 'vitest';
import type { BriefFacts } from '../../src/brief/facts.ts';
import { makeEvent, type EventKind, type Source, type WorkEvent } from '../../src/model/event.ts';
import { buildStandup, renderStandup } from '../../src/render/standup.ts';
import { rahulEvents } from '../brief/rahul.ts';
import { rahulFacts } from './helpers.ts';

let seq = 0;
function ev(
  root: string,
  source: Source,
  kind: EventKind,
  summary: string,
  data: Record<string, unknown> = {},
): WorkEvent {
  return makeEvent({
    source,
    kind,
    projectRoot: root,
    ts: new Date(Date.parse('2026-10-20T10:00:00.000Z') + seq * 60_000).toISOString(),
    sessionRef: null,
    summary,
    data,
    dedupeKey: `standup-${seq++}`,
  });
}

// Facts with nothing to do today and no blockers, for the Yesterday tests.
function quiet(root: string): BriefFacts {
  return {
    ...rahulFacts(),
    project: { root, name: root.split('/').at(-1) as string },
    openProblems: [],
    claimedDone: null,
    nextStep: null,
  };
}

const edit = (root: string, source: Source, file: string) =>
  ev(root, source, 'file_edit', `Edited ${file}`, { path: `${root}/${file}` });

test('rahul standup', () => {
  expect(
    renderStandup(buildStandup({ factsByProject: [rahulFacts()], eventsSince: rahulEvents() })),
  ).toBe(
    `Yesterday:
- Built POST /auth/forgot-password endpoint
- Added reset-token migration
Today:
- Resolve: \`python scripts/send_test_email.py\` — SMTP connection refused
Blockers:
- \`python scripts/send_test_email.py\` — SMTP connection refused`,
  );
});

test('project without commits gets "Worked on <files> with <agent>"', () => {
  const root = '/p/api';
  const events = [
    edit(root, 'claude', 'a.py'),
    edit(root, 'claude', 'a.py'),
    edit(root, 'codex', 'b.py'),
    edit(root, 'claude', 'c.py'),
  ];
  const s = buildStandup({ factsByProject: [quiet(root)], eventsSince: events });
  expect(s.yesterday).toEqual(['Worked on a.py, b.py, c.py with claude and codex']);
});

test('more than three edited files are shortened to "and N more"', () => {
  const root = '/p/api';
  const events = ['a', 'b', 'c', 'd', 'e'].map((f) => edit(root, 'claude', `${f}.ts`));
  const s = buildStandup({ factsByProject: [quiet(root)], eventsSince: events });
  expect(s.yesterday).toEqual(['Worked on a.ts, b.ts, c.ts and 2 more with claude']);
});

test('a project with commits gets no "Worked on" line (plan review B4)', () => {
  const s = buildStandup({ factsByProject: [rahulFacts()], eventsSince: rahulEvents() });
  expect(s.yesterday.some((l) => l.startsWith('Worked'))).toBe(false);
});

test('no commits and no edits: "Worked on: <last request>"', () => {
  const root = '/p/api';
  const events = [
    ev(root, 'claude', 'user_prompt', 'Explain the retry logic'),
    ev(root, 'claude', 'user_prompt', 'Add rate limiting to /login'),
    ev(root, 'shell', 'command', 'npm test', { command: 'npm test', exitCode: 0 }),
  ];
  const s = buildStandup({ factsByProject: [quiet(root)], eventsSince: events });
  expect(s.yesterday).toEqual(['Worked on: Add rate limiting to /login']);
});

test('no commits, edits or requests: "Worked in <project> with <tools>"', () => {
  const root = '/p/api';
  const events = [
    ev(root, 'shell', 'command', 'make', { command: 'make', exitCode: 0 }),
    ev(root, 'codex', 'command', 'ls', { command: 'ls', exitCode: 0 }),
  ];
  const s = buildStandup({ factsByProject: [quiet(root)], eventsSince: events });
  expect(s.yesterday).toEqual(['Worked in api with the shell and codex']);
});

test('no activity → Blockers: none and a friendly Yesterday line', () => {
  expect(renderStandup(buildStandup({ factsByProject: [], eventsSince: [] }))).toBe(
    `Yesterday:
- No activity recorded in this period
Today: none
Blockers: none`,
  );
});

test('--all prefixes project names', () => {
  const api = '/p/api';
  const s = buildStandup(
    {
      factsByProject: [rahulFacts(), quiet(api)],
      eventsSince: [...rahulEvents(), edit(api, 'codex', 'server.go')],
    },
    { prefix: true },
  );
  expect(s.yesterday).toEqual([
    'myapp: Built POST /auth/forgot-password endpoint',
    'myapp: Added reset-token migration',
    'api: Worked on server.go with codex',
  ]);
  expect(s.today).toEqual([
    'myapp: Resolve: `python scripts/send_test_email.py` — SMTP connection refused',
  ]);
  expect(s.blockers).toEqual([
    'myapp: `python scripts/send_test_email.py` — SMTP connection refused',
  ]);
});

test('events of projects not in the standup are ignored', () => {
  const s = buildStandup({
    factsByProject: [rahulFacts()],
    eventsSince: [...rahulEvents(), ev('/elsewhere', 'git', 'commit', 'Unrelated')],
  });
  expect(s.yesterday).not.toContain('Unrelated');
});
