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

test('an agent failure with 2>&1 is resolved by the same command succeeding in your shell', () => {
  const [failure, success] = timeline(
    fail('npm run lint 2>&1', 'Missing script: "lint"'),
    ok('npm run lint'),
  );
  const fromShell = { ...(success as WorkEvent), source: 'shell' as const };
  expect(findOpenProblems([failure as WorkEvent, fromShell])).toEqual([]);
});

test('a leading `cd <dir> &&` is ignored when matching, and the command is shown without it', () => {
  expect(findOpenProblems(timeline(fail('cd /x && npm test', '1 failed'), ok('npm test')))).toEqual(
    [],
  );
  const [p] = findOpenProblems(timeline(fail('cd /x && npm test 2>&1 | tail -20', '1 failed')));
  expect(p?.command).toBe('npm test');
});

test('a failure is resolved by a later success with the same program + subcommand key', () => {
  expect(
    findOpenProblems(
      timeline(fail('npx vitest run tests/a.test.ts', '1 failed'), ok('npx vitest run')),
    ),
  ).toEqual([]);
  expect(
    findOpenProblems(timeline(fail('npm test -- --grep x', '1 failed'), ok('npm test'))),
  ).toEqual([]);
});

test('a different script or subcommand does not resolve a failure', () => {
  const open = (failing: string, passing: string) =>
    findOpenProblems(timeline(fail(failing, 'broke'), ok(passing))).map((p) => p.command);
  expect(open('npm run lint', 'npm run build')).toEqual(['npm run lint']);
  expect(open('python scripts/a.py', 'python scripts/b.py')).toEqual(['python scripts/a.py']);
});

test('scratch failures from an agent are not open problems, contradictions or the next step', () => {
  const events = timeline(
    fail("python3 - <<'EOF'\nprint(x)\nEOF", 'NameError: x'),
    fail('cat package.json | jq .nope', 'jq: error'),
    fail('node -e "boom()"', 'ReferenceError'),
    ['agent_message', 'All done.', {}],
  );
  expect(findOpenProblems(events)).toEqual([]);
  expect(detectClaimedDone(events, [], 0)).toBeNull();
  // A project command failing in the same session is still a problem.
  const withReal = timeline(fail('cat a | jq .x', 'jq: error'), fail('npm test', '1 failed'));
  expect(findOpenProblems(withReal).map((p) => p.command)).toEqual(['npm test']);
});

test('scratch is decided at read time too (events stored before the rule), and data.scratch is honoured', () => {
  const flagged = timeline([
    'command_failed',
    'x failed',
    { command: 'npm test', exitCode: 1, error: 'e', scratch: true },
  ]);
  expect(findOpenProblems(flagged)).toEqual([]);
  // Your own shell commands are never scratch: they stay open.
  const fromShell = timeline(fail('cat a | jq .x', 'jq: error')).map((e) => ({
    ...e,
    source: 'shell' as const,
  }));
  expect(findOpenProblems(fromShell)).toHaveLength(1);
});

test('a passing test run piped into a filter (grep exits 1: no match) is not a problem; a failing one is', () => {
  const run = (output: string) =>
    findOpenProblems(
      timeline([
        'command_failed',
        'x',
        { command: 'npx vitest run | grep FAIL', exitCode: 1, error: output },
      ]),
    );
  expect(run('')).toEqual([]);
  expect(run('Tests  12 passed (12)')).toEqual([]);
  expect(run(' FAIL  tests/a.test.ts > adds\nTests  1 failed | 11 passed (12)')).toHaveLength(1);
  // In a chain, an earlier step's exit code is not the filter's: still a failure.
  const chain = timeline([
    'command_failed',
    'x',
    {
      command: 'git status --short && git diff | sed -n 1,5p',
      exitCode: 128,
      error: 'fatal: not a git repository',
    },
  ]);
  expect(findOpenProblems(chain)).toHaveLength(1);
  // Leading cd steps are fine.
  expect(
    findOpenProblems(
      timeline([
        'command_failed',
        'x',
        { command: 'cd app && npm test | grep FAIL', exitCode: 1, error: '' },
      ]),
    ),
  ).toEqual([]);
  // A real failure seen through a filter is resolved by a later passing run seen through one.
  const seenThroughFilters = timeline(
    [
      'test_failed',
      'Tests failed',
      { command: 'npx vitest run --project unit 2>&1 | grep -E -A15 "FAIL " | head -40' },
    ],
    [
      'command',
      'ok',
      { command: 'npx vitest run --project unit 2>&1 | grep -E "Tests "', exitCode: 0 },
    ],
  );
  expect(findOpenProblems(seenThroughFilters)).toEqual([]);
  // A passing filtered run also resolves an earlier failure of the same command.
  const resolved = timeline(fail('npx vitest run', '1 failed'), [
    'command_failed',
    'x',
    { command: 'npx vitest run | grep FAIL', exitCode: 1, error: '' },
  ]);
  expect(findOpenProblems(resolved)).toEqual([]);
});

test('probes are decided at read time too: an older git diff --no-index with exit 1 is not a problem', () => {
  const events = timeline([
    'command_failed',
    'x',
    {
      command: 'git diff --no-index -- /dev/null tests/a.py',
      exitCode: 1,
      error: 'diff --git a/x',
    },
  ]);
  expect(findOpenProblems(events)).toEqual([]);
});

test('file-scoped resolution: a success with other file arguments does not resolve a failure', () => {
  const open = (failing: string, passing: string) =>
    findOpenProblems(timeline(fail(failing, 'broke'), ok(passing))).map((p) => p.command);
  expect(open('npx vitest run tests/a.test.ts', 'npx vitest run')).toEqual([]); // whole-project run
  expect(
    open('npx vitest run tests/a.test.ts', 'npx vitest run tests/a.test.ts --reporter dot'),
  ).toEqual([]);
  expect(open('prettier --write src/a.ts', 'prettier --write src/b.ts')).toEqual([
    'prettier --write src/a.ts',
  ]);
  expect(open('ruff format --check src/a.py src/b.py', 'ruff format src/c.py')).toEqual([
    'ruff format --check src/a.py src/b.py',
  ]);
  expect(open('tsc --noEmit --pretty false', 'tsc --noEmit --strict')).toEqual([]);
  // Without file arguments the failure is not file-scoped: any same-key success resolves it.
  expect(open('tsc --noEmit', 'tsc --noEmit src/index.ts')).toEqual([]);
});

test('claimed done quotes the sentence with the done-word, cut at word boundaries, about 100 chars at most', () => {
  const claim = (message: string) =>
    detectClaimedDone(
      timeline(fail('npm test', '1 failed'), ['agent_message', message, {}]),
      findOpenProblems(timeline(fail('npm test', '1 failed'))),
      0,
    )?.message;
  expect(
    claim('I updated the parser and the docs. All tests pass now. Next I will look at the CLI.'),
  ).toBe('All tests pass now.');
  const long = `First part. ${'word '.repeat(30)}and now everything is done ${'more '.repeat(30)}end. Bye.`;
  const quoted = claim(long) as string;
  expect([...quoted].length).toBeLessThanOrEqual(102);
  expect(quoted).toContain('done');
  expect(quoted).toMatch(/^…(\w+ )+.*done.*( \w+)+…$/);
});

test('an open problem shows its command without setup prefixes and trailing filters (owner decision after Task 14)', () => {
  const [p] = findOpenProblems(
    timeline(
      fail(
        'source "$HOME/.cargo/env" && cargo test -p looplint_adapters | grep -E "^error" -A6',
        'test result: FAILED',
      ),
    ),
  );
  expect(p?.command).toBe('cargo test -p looplint_adapters');
  expect(problemText(p as OpenProblem)).toBe(
    '`cargo test -p looplint_adapters` — test result: FAILED',
  );
});

test('questions and offers are never done-claims; a claim sentence elsewhere in the message still counts', () => {
  const claim = (message: string) =>
    detectClaimedDone(
      timeline(fail('npm test', '1 failed'), ['agent_message', message, {}]),
      findOpenProblems(timeline(fail('npm test', '1 failed'))),
      0,
    )?.message ?? null;
  expect(claim('Is the parser fixed now?')).toBeNull();
  expect(claim('Should the loose end be fixed in this commit or left for Task 18?')).toBeNull();
  expect(claim('It can be fixed in this commit or left for later.')).toBeNull();
  expect(claim('Should I mark this done.')).toBeNull();
  expect(claim('Want me to say it is finished!')).toBeNull();
  expect(claim('Shall I commit and say it is done.')).toBeNull();
  expect(claim('Do you want me to push this as done')).toBeNull();
  // The question is skipped, the plain claim after it is quoted.
  expect(claim('Was it the cache? Fixed the cache key.')).toBe('Fixed the cache key.');
  // An earlier real claim is not hidden by a newer question.
  expect(
    detectClaimedDone(
      timeline(
        fail('npm test', '1 failed'),
        ['agent_message', 'All tests pass.', {}],
        ['agent_message', 'Should I push it or wait until it is fixed?', {}],
      ),
      findOpenProblems(timeline(fail('npm test', '1 failed'))),
      0,
    )?.message,
  ).toBe('All tests pass.');
  // A commit word inside an offer does not make the claim a commit claim (R-D1).
  expect(
    detectClaimedDone(
      timeline(['agent_message', 'Done. Want me to check that it merged cleanly?', {}]),
      [],
      2,
    ),
  ).toBeNull();
});

test('displayed texts are one line: multi-line attempts show their first line + " …"', () => {
  const [p] = findOpenProblems(
    timeline(fail('npm test', '1 failed'), ok("python3 - <<'EOF'\nprint(1)\nEOF"), [
      'file_edit',
      'Edited   src/a.ts',
      { path: '/p/src/a.ts' },
    ]),
  );
  expect(p?.attempts).toEqual(["python3 - <<'EOF' …", 'Edited src/a.ts']);
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

test('quotes are one line and start and end at a word boundary', () => {
  repo.insertEvents(
    timeline(
      ['user_prompt', 'Fix the login\n   flow please, and the reset emails that were cut mi…', {}],
      ['agent_message', '…ord boundary here.\n\nAll done.', {}],
    ),
  );
  const f = buildFacts('/p', {
    repo,
    config,
    report: null,
    working: null,
    now: new Date('2026-10-20T11:00:00.000Z'),
  });
  expect(f.lastIntent).toBe('Fix the login flow please, and the reset emails that were cut…');
  expect(f.lastAgentMessage).toBe('…boundary here. All done.');
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
