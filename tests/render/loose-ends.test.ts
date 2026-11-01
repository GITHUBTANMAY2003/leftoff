import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import {
  contradictionOf,
  type ClaimedDone,
  type LooseEnds,
  type OpenProblem,
} from '../../src/brief/facts.ts';
import { renderLooseEnds } from '../../src/render/loose-ends.ts';

// `leftoff` / `leftoff loops`: compact, at most 3 lines per project — when,
// what you were working on, the next step (owner request after Task 17
// started). The claim and the counts ride on the first and last lines.

const NOW = new Date('2026-10-21T08:30:00.000Z');
const golden = (name: string) => readFileSync(join(import.meta.dirname, 'golden', name), 'utf8');

const problem = (error: string, command: string | null, isTest = false): OpenProblem => ({
  error,
  command,
  isTest,
  source: 'claude',
  firstSeen: '2026-10-20T17:00:00.000Z',
  attempts: [],
});
const claim = (message: string, contradictions: string[]): ClaimedDone => ({
  source: 'claude',
  message,
  at: '2026-10-20T18:00:00.000Z',
  contradictions,
});
const entry = (over: Partial<LooseEnds>): LooseEnds => ({
  project: { root: '/w/myapp', name: 'myapp' },
  branch: 'main',
  lastActiveAt: '2026-10-20T18:30:00.000Z',
  stale: false,
  claimedDone: null,
  openProblems: [],
  uncommittedCount: 0,
  gitUnavailable: false,
  workingOn: null,
  lastIntent: null,
  nextStep: null,
  ...over,
});

const PYTEST = problem('1 failed, 4 passed', 'pytest tests/test_reset.py', true);
const SMTP = problem('SMTP connection refused', null);

function sample(): LooseEnds[] {
  return [
    entry({
      branch: 'feature/forgot-password',
      claimedDone: claim('All tests pass', [contradictionOf(PYTEST)]),
      openProblems: [PYTEST, SMTP],
      uncommittedCount: 1,
      workingOn: 'building forgot password',
      nextStep: 'Make the reset tests pass (`pytest tests/test_reset.py`)',
    }),
    entry({
      project: { root: '/w/api-server', name: 'api-server' },
      lastActiveAt: '2026-10-17T08:30:00.000Z',
      stale: true,
      uncommittedCount: 3,
      lastIntent: 'Add rate limits to the public API. Then document them.',
      nextStep: 'Review and commit 3 uncommitted files (a.ts, b.ts, c.ts)',
    }),
  ];
}

const render = (items: LooseEnds[]) => renderLooseEnds(items, NOW, { color: false });
const header = (e: LooseEnds) => render([e]).split('\n')[2];

test('loose ends: render matches golden', () => {
  expect(render(sample()) + '\n').toBe(golden('loose-ends.txt'));
});

test('no loose ends → the single "No loose ends." line', () => {
  expect(render([])).toBe('No loose ends. Everything is committed and passing.');
});

test('one project is "1 project"', () => {
  expect(render([entry({ uncommittedCount: 1 })]).split('\n')[0]).toBe(
    'Loose ends across 1 project',
  );
});

test('with color, the text is the same once the ANSI codes are removed', () => {
  const colored = renderLooseEnds(sample(), NOW, { color: true });
  // eslint-disable-next-line no-control-regex -- matching ANSI color codes is the point
  expect(colored).toMatch(/\x1b\[/);
  // eslint-disable-next-line no-control-regex -- matching ANSI color codes is the point
  expect(colored.replace(/\x1b\[[0-9;]*m/g, '')).toBe(render(sample()));
});

// ---- after 15d: one count everywhere, headers never cut ----

test('the header says who claimed done and how many problems are open, counted as groups', () => {
  const t1 = problem('a', 'cargo test -p core', true);
  const t2 = problem('b', 'cargo test -p cli', true);
  const lint = problem('c', 'npm run lint');
  expect(
    header(
      entry({ claimedDone: claim('Done.', [contradictionOf(t1)]), openProblems: [t1, t2, lint] }),
    ),
  ).toBe('myapp (main) · last worked 14h ago · Claude said done · 2 problems open');
  expect(header(entry({ openProblems: [lint], uncommittedCount: 3, stale: true }))).toBe(
    'myapp (main) · last worked 14h ago · 1 problem open · 3 uncommitted files · stale',
  );
  expect(header(entry({ gitUnavailable: true }))).toBe(
    'myapp (main) · last worked 14h ago · git status unavailable',
  );
  expect(header(entry({ branch: null, uncommittedCount: 1 }))).toBe(
    'myapp · last worked 14h ago · 1 uncommitted file',
  );
});

test('a header too long for one line moves the branch to its own line; nothing is cut', () => {
  const out = render([
    entry({
      project: { root: '/w/x', name: 'hackerrank-orchestrate-october26' },
      branch: 'feature/a-rather-long-branch-name-for-the-audit',
      claimedDone: claim('Committed.', ['2 uncommitted files']),
      uncommittedCount: 2,
      stale: true,
      nextStep: 'Commit the 2 files Claude said were committed',
    }),
  ]).split('\n');
  expect(out.slice(2, 6)).toEqual([
    'hackerrank-orchestrate-october26 · last worked 14h ago · Claude said done · 2 uncommitted files · stale',
    '  on branch feature/a-rather-long-branch-name-for-the-audit',
    '  Next: Commit the 2 files Claude said were committed.',
    '',
  ]);
  expect(out.join('\n')).not.toContain('…');
});

test('a long next step keeps its first action instead of being cut', () => {
  const out = render([
    entry({
      openProblems: [problem('SMTP connection refused', 'python scripts/send_test_email.py')],
      nextStep: `Fix "SMTP connection refused", then run \`python scripts/send_test_email.py --with-a-long-flag\` again`,
    }),
  ]);
  expect(out).toContain('  Next: Fix "SMTP connection refused".\n');
});

test('the first action is split at a comma outside brackets', () => {
  const out = render([
    entry({
      uncommittedCount: 24,
      nextStep: `Review and commit 24 uncommitted files (${'src/brief/facts.ts, '.repeat(4)}and 20 more), then push`,
    }),
  ]);
  expect(out).toContain('  Next: Review and commit 24 uncommitted files.\n');
});
