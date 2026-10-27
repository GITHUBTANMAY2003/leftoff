import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Database } from 'better-sqlite3';
import { afterEach, beforeEach, expect, test } from 'vitest';
import {
  buildFacts,
  detectClaimedDone,
  findOpenProblems,
  problemText,
  type OpenProblem,
} from '../../src/brief/facts.ts';
import { factsHash } from '../../src/brief/hash.ts';
import { DEFAULT_CONFIG, type Config } from '../../src/core/config.ts';
import { makeEvent, type EventKind, type WorkEvent } from '../../src/model/event.ts';
import { openDb } from '../../src/store/db.ts';
import { createRepo, type Repo } from '../../src/store/repo.ts';
import { RAHUL_NOW, RAHUL_REPORT, RAHUL_ROOT, RAHUL_WORKING, rahulEvents } from './rahul.ts';

let tmp: string;
let db: Database;
let repo: Repo;
let config: Config;
const savedHome = process.env.LEFTOFF_HOME;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'leftoff-facts-'));
  process.env.LEFTOFF_HOME = tmp;
  db = openDb(join(tmp, 'leftoff.db'));
  repo = createRepo(db);
  config = structuredClone(DEFAULT_CONFIG) as Config;
});

afterEach(() => {
  db.close();
  if (savedHome === undefined) delete process.env.LEFTOFF_HOME;
  else process.env.LEFTOFF_HOME = savedHome;
  rmSync(tmp, { recursive: true, force: true });
});

let seq = 0;
// Events one minute apart from 10:00, in the given order.
function timeline(...specs: [EventKind, string, Record<string, unknown>?, string?][]): WorkEvent[] {
  return specs.map(([kind, summary, data = {}, session = 's1'], i) =>
    makeEvent({
      source: kind === 'commit' ? 'git' : 'claude',
      kind,
      projectRoot: '/p',
      ts: new Date(Date.parse('2026-10-20T10:00:00.000Z') + i * 60_000).toISOString(),
      sessionRef: session,
      summary,
      data,
      dedupeKey: `t${seq++}`,
    }),
  );
}
const fail = (
  command: string,
  error: string,
  session?: string,
): [EventKind, string, Record<string, unknown>, string?] => [
  'command_failed',
  `\`${command}\` failed: ${error}`,
  { command, exitCode: 1, error },
  session,
];
const ok = (command: string, summary = command): [EventKind, string, Record<string, unknown>] => [
  'command',
  summary,
  { command, exitCode: 0 },
];

test('open problem: failure without later success', () => {
  const p = findOpenProblems(rahulEvents());
  expect(p).toHaveLength(1);
  expect(p[0]?.error).toContain('SMTP connection refused');
  expect(p[0]?.attempts).toEqual(['changed port to 587', 'disabled TLS']); // summaries from fixture helper
  expect(p[0]).toMatchObject({ source: 'claude', firstSeen: '2026-10-20T17:50:00.000Z' });
});

test('failure followed by same command succeeding is resolved', () => {
  expect(findOpenProblems(timeline(fail('npm test', '1 failed'), ok('npm test')))).toEqual([]);
});

test('success matching uses the normalized command (whitespace, leading env assignments)', () => {
  const events = timeline(fail('CI=1  npm   test', '1 failed'), ok('npm test'));
  expect(findOpenProblems(events)).toEqual([]);
});

test('a success before the failure does not resolve it', () => {
  expect(findOpenProblems(timeline(ok('npm test'), fail('npm test', '1 failed')))).toHaveLength(1);
});

test('repeated failures of one command are one problem: first seen = first failure, error = newest', () => {
  const p = findOpenProblems(timeline(fail('make', 'error A'), fail('make', 'error B')));
  expect(p).toHaveLength(1);
  expect(p[0]).toMatchObject({ error: 'error B', firstSeen: '2026-10-20T10:00:00.000Z' });
});

test('a failing test run (command_failed + test_failed for one command) is one problem', () => {
  const events = timeline(fail('node --test', '✖ add'), [
    'test_failed',
    'Tests failed: `node --test`',
    { command: 'node --test', output: '✖ add' },
  ]);
  expect(findOpenProblems(events)).toHaveLength(1);
});

test('open problems are newest first', () => {
  const p = findOpenProblems(timeline(fail('a', 'first'), fail('b', 'second')));
  expect(p.map((x) => x.error)).toEqual(['second', 'first']);
});

test('a tool error without a command stays open (nothing can resolve it)', () => {
  const p = findOpenProblems(
    timeline([
      'tool_error',
      'Read failed: File does not exist.',
      { tool: 'Read', error: 'File does not exist.' },
    ]),
  );
  expect(p.map((x) => x.error)).toEqual(['File does not exist.']);
});

test('attempts capped at 5 and deduplicated', () => {
  const events = timeline(
    fail('deploy', 'boom'),
    ok('a'),
    ok('a'),
    ['file_edit', 'Edited x.py', { path: '/p/x.py' }],
    ok('b'),
    ok('c'),
    ok('d'),
    ok('e'),
    ok('f'),
  );
  expect(findOpenProblems(events)[0]?.attempts).toEqual(['a', 'Edited x.py', 'b', 'c', 'd']);
});

test('claimed done: "All tests pass" then a test failure → flagged with "(still failing)"', () => {
  const events = timeline(['agent_message', 'All tests pass.'], fail('npm test', '1 failed'));
  const cd = detectClaimedDone(events, findOpenProblems(events), 0);
  expect(cd).toMatchObject({
    source: 'claude',
    message: 'All tests pass.',
    contradictions: ['`npm test` — 1 failed (still failing)'],
  });
});

test('claimed done: an open problem from the same agent session before the claim contradicts it', () => {
  const events = timeline(fail('npm run lint', 'Missing script: "lint"'), [
    'agent_message',
    'Done!',
  ]);
  expect(detectClaimedDone(events, findOpenProblems(events), 0)?.contradictions).toEqual([
    '`npm run lint` — Missing script: "lint" (still failing)',
  ]);
});

test('claimed done: an older open problem from another session does not contradict it', () => {
  const events = timeline(fail('old-script', 'broken', 'other-session'), [
    'agent_message',
    'Done!',
  ]);
  expect(detectClaimedDone(events, findOpenProblems(events), 0)).toBeNull();
});

test('claimed done: "Done!" with uncommitted files and no later commit → null (uncommitted alone is not a contradiction)', () => {
  const events = timeline(['agent_message', 'Done!']);
  expect(detectClaimedDone(events, [], 2)).toBeNull(); // R-D1
});

test.each(['Committed the fix', 'Pushed to origin', 'Merged into main', 'Ready to merge'])(
  'claimed done: %j with 2 uncommitted files and no later commit → "2 uncommitted files"',
  (claim) => {
    const events = timeline(['agent_message', claim]);
    expect(detectClaimedDone(events, [], 2)?.contradictions).toEqual(['2 uncommitted files']); // R-D1
  },
);

test('claimed done: one uncommitted file is singular', () => {
  expect(
    detectClaimedDone(timeline(['agent_message', 'Committed.']), [], 1)?.contradictions,
  ).toEqual(['1 uncommitted file']);
});

test('claimed done: "Committed the fix" followed by a commit event → null', () => {
  const events = timeline(['agent_message', 'Committed the fix'], ['commit', 'fix: smtp port']);
  expect(detectClaimedDone(events, [], 2)).toBeNull(); // R-D1
});

test('claimed done: claim, then failure, then fix and passing re-run → null', () => {
  const events = timeline(
    ['agent_message', 'All tests pass'],
    fail('npm test', '1 failed'),
    ['file_edit', 'Edited calc.js', { path: '/p/calc.js' }],
    ok('npm test'),
  );
  expect(detectClaimedDone(events, findOpenProblems(events), 0)).toBeNull();
});

test.each(["I haven't finished the migration", 'not done yet', "it's still not passing"])(
  'claimed done: negation %j is never a claim',
  (text) => {
    const events = timeline(['agent_message', text], fail('npm test', '1 failed'));
    expect(detectClaimedDone(events, findOpenProblems(events), 3)).toBeNull();
  },
);

test('claimed done: "Done reading the file, now editing" with nothing contradicting → null', () => {
  expect(
    detectClaimedDone(timeline(['agent_message', 'Done reading the file, now editing']), [], 0),
  ).toBeNull();
});

test('claimed done: no agent message → null', () => {
  const events = timeline(fail('npm test', '1 failed'));
  expect(detectClaimedDone(events, findOpenProblems(events), 1)).toBeNull();
});

test('claimed done: the newest matching message is the claim', () => {
  const events = timeline(
    ['agent_message', 'Fixed the parser.'],
    fail('npm test', '1 failed'),
    ['agent_message', 'All tests pass now.'],
    ['agent_message', 'Let me know if you need anything else.'],
  );
  expect(detectClaimedDone(events, findOpenProblems(events), 0)?.message).toBe(
    'All tests pass now.',
  );
});

function deps(events: WorkEvent[], over: Partial<Parameters<typeof buildFacts>[1]> = {}) {
  repo.insertEvents(events);
  return { repo, config, report: RAHUL_REPORT, working: RAHUL_WORKING, now: RAHUL_NOW, ...over };
}

test('buildFacts for rahul scenario', () => {
  const f = buildFacts(RAHUL_ROOT, deps(rahulEvents()));
  expect(f.project).toEqual({ root: RAHUL_ROOT, name: 'myapp' });
  expect(f.branch).toBe('feature/forgot-password');
  expect(f.unfinished.files[0]?.path).toBe('email_service.py');
  expect(f.nextStep).toBe('Resolve: `python scripts/send_test_email.py` — SMTP connection refused');
  expect(f.done).toEqual([
    'Built POST /auth/forgot-password endpoint',
    'Added reset-token migration',
  ]);
  expect(f.openProblems.map((p) => p.attempts)).toEqual([['changed port to 587', 'disabled TLS']]);
  expect(f.claimedDone).toBeNull();
  expect(f.lastActiveAt).toBe('2026-10-20T18:30:00.000Z');
  expect(f.lastIntent).toBe('Add a forgot-password flow: endpoint, reset token, email');
  expect(f.lastAgentMessage).toBe('The SMTP server still refuses the connection on both ports.');
  expect(f.window).toEqual({ from: '2026-10-20T17:00:00.000Z', to: '2026-10-20T18:30:00.000Z' });
  expect(f.sources).toEqual([
    { name: 'claude', status: 'ok' },
    { name: 'git', status: 'ok' },
    { name: 'shell', status: 'ok' },
    { name: 'codex', status: 'not_found' },
  ]);
});

test('window: the most recent work session only', () => {
  const old = makeEvent({
    source: 'claude',
    kind: 'user_prompt',
    projectRoot: RAHUL_ROOT,
    ts: '2026-10-19T09:00:00.000Z',
    sessionRef: null,
    summary: 'yesterday morning work',
    dedupeKey: 'old',
  });
  const f = buildFacts(RAHUL_ROOT, deps([old, ...rahulEvents()]));
  expect(f.lastIntent).toBe('Add a forgot-password flow: endpoint, reset token, email');
  expect(f.window.from).toBe('2026-10-20T17:00:00.000Z');
});

test('window includes previous session when last has < 3 events', () => {
  const late = makeEvent({
    source: 'claude',
    kind: 'user_prompt',
    projectRoot: RAHUL_ROOT,
    ts: '2026-10-20T22:00:00.000Z',
    sessionRef: null,
    summary: 'one more thing',
    dedupeKey: 'late',
  });
  const f = buildFacts(RAHUL_ROOT, deps([...rahulEvents(), late]));
  expect(f.window).toEqual({ from: '2026-10-20T17:00:00.000Z', to: '2026-10-20T22:00:00.000Z' });
  expect(f.openProblems).toHaveLength(1); // still found in the previous session
  expect(f.lastIntent).toBe('one more thing');
});

test('done lists commit subjects, then "Edited N files" from the window', () => {
  const edit = (n: number, path: string) =>
    makeEvent({
      source: 'claude',
      kind: 'file_edit',
      projectRoot: '/p',
      ts: `2026-10-20T10:0${n}:00.000Z`,
      sessionRef: null,
      summary: `Edited ${path}`,
      data: { path: `/p/${path}` },
      dedupeKey: `e${n}`,
    });
  const commitEv = makeEvent({
    source: 'git',
    kind: 'commit',
    projectRoot: '/p',
    ts: '2026-10-20T10:00:00.000Z',
    sessionRef: null,
    summary: 'feat: a',
    dedupeKey: 'c',
  });
  const f = buildFacts(
    '/p',
    deps(
      [
        commitEv,
        edit(1, 'a.py'),
        edit(2, 'b.py'),
        edit(3, 'a.py'),
        edit(4, 'src/c.py'),
        edit(5, 'd.py'),
      ],
      { now: new Date('2026-10-20T12:00:00.000Z') },
    ),
  );
  expect(f.done).toEqual(['feat: a', 'Edited 4 files: a.py, b.py, src/c.py and 1 more']);
});

test('notes always appear (all notes kept, oldest first), even outside the window', () => {
  const note = (ts: string, text: string) =>
    makeEvent({
      source: 'user',
      kind: 'note',
      projectRoot: RAHUL_ROOT,
      ts,
      sessionRef: null,
      summary: text,
      dedupeKey: `n-${ts}`,
    });
  const f = buildFacts(
    RAHUL_ROOT,
    deps([
      note('2026-10-18T09:00:00.000Z', 'ask about SES'),
      ...rahulEvents(),
      note('2026-10-20T18:40:00.000Z', 'next: try the app password'),
    ]),
  );
  expect(f.notes).toEqual(['ask about SES', 'next: try the app password']);
  expect(f.nextStep).toBe('try the app password');
});

test('buildFacts works with no events and no git (empty brief, no throw)', () => {
  const f = buildFacts('/nowhere/empty', deps([], { working: null, report: null }));
  expect(f).toMatchObject({
    project: { root: '/nowhere/empty', name: 'empty' },
    branch: null,
    lastActiveAt: null,
    done: [],
    unfinished: { files: [], diffStat: null },
    openProblems: [],
    claimedDone: null,
    notes: [],
    nextStep: null,
  });
  expect(f.sources.map((s) => s.status)).toEqual([
    'not_found',
    'not_found',
    'not_found',
    'not_found',
  ]);
});

test('without a report, sources come from the last stored ingest report', () => {
  repo.setCursor('ingest', 'last_report', JSON.stringify({ at: 'x', ...RAHUL_REPORT }));
  const f = buildFacts(RAHUL_ROOT, deps(rahulEvents(), { report: null }));
  expect(f.sources.map((s) => s.status)).toEqual(['ok', 'ok', 'ok', 'not_found']);
});

test('a source error carries its detail', () => {
  const report = structuredClone(RAHUL_REPORT);
  report.perSource.claude = { status: 'error', inserted: 0, warnings: [], detail: 'timeout' };
  const f = buildFacts(RAHUL_ROOT, deps(rahulEvents(), { report }));
  expect(f.sources[0]).toEqual({ name: 'claude', status: 'error', detail: 'timeout' });
});

test('events older than retentionDays are not considered', () => {
  config.retentionDays = 1;
  const f = buildFacts(
    RAHUL_ROOT,
    deps(rahulEvents(), { now: new Date('2026-10-23T00:00:00.000Z') }),
  );
  expect(f.lastActiveAt).toBeNull();
  expect(f.openProblems).toEqual([]);
});

test('factsHash ignores lastActiveAt', () => {
  const f = buildFacts(RAHUL_ROOT, deps(rahulEvents()));
  const moved = { ...f, lastActiveAt: '2030-01-01T00:00:00.000Z', sources: [] };
  expect(factsHash(moved)).toBe(factsHash(f));
  expect(factsHash({ ...f, nextStep: 'something else' })).not.toBe(factsHash(f));
  expect(factsHash(f)).toMatch(/^[0-9a-f]{40}$/);
});

test('probe failures are not open problems and do not contradict a claim, but stay in the events', () => {
  const events = timeline(
    [
      'command_failed',
      '`ls /nope` failed: no such file',
      { command: 'ls /nope', exitCode: 1, error: 'no such file', probe: true },
    ],
    [
      'tool_error',
      'Read failed: File does not exist.',
      { tool: 'Read', error: 'File does not exist.', probe: true },
    ],
    ['agent_message', 'All done.'],
  );
  expect(findOpenProblems(events)).toEqual([]);
  expect(detectClaimedDone(events, findOpenProblems(events), 0)).toBeNull();
});

test('an open problem carries its normalized command, shown before the error', () => {
  const [p] = findOpenProblems(timeline(fail('CI=1   npm run lint', 'Missing script: "lint"')));
  expect(p?.command).toBe('npm run lint');
  expect(problemText(p as OpenProblem)).toBe('`npm run lint` — Missing script: "lint"');
});

test('a failure with no error text shows its exit code after the command', () => {
  const [p] = findOpenProblems(
    timeline([
      'command_failed',
      '`npx --no-install eslint .` failed: exit code 130',
      { command: 'npx --no-install eslint .', exitCode: 130, error: '' },
    ]),
  );
  expect(problemText(p as OpenProblem)).toBe('`npx --no-install eslint .` — exit code 130');
});

test('a tool error without a command is shown by its error text alone', () => {
  const [p] = findOpenProblems(
    timeline(['tool_error', 'Edit failed', { tool: 'Edit', error: 'old_string not found' }]),
  );
  expect(p?.command).toBeNull();
  expect(problemText(p as OpenProblem)).toBe('old_string not found');
});

test('an open problem whose failures include a failed test run is marked as a test', () => {
  const problems = findOpenProblems(
    timeline(
      fail('npm test', '1 failed'),
      [
        'test_failed',
        'Tests failed: `npm test`',
        {
          command: 'npm test',
          output: '1 failed',
        },
      ],
      fail('npm run lint', 'Missing script'),
    ),
  );
  expect(problems.map((p) => [p.command, p.isTest])).toEqual([
    ['npm run lint', false],
    ['npm test', true],
  ]);
});
