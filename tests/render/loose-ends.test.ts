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

test('the claim on the first line counts tests and other problems', () => {
  const t2 = problem('a', 'npm test', true);
  const t3 = problem('b', 'npm run e2e', true);
  const lint = problem('c', 'npm run lint');
  const said = (ps: OpenProblem[], extra: string[] = []) =>
    header(
      entry({
        claimedDone: claim('Done.', [...ps.map(contradictionOf), ...extra]),
        openProblems: ps,
      }),
    );
  expect(said([t2, t3])).toBe(
    'myapp (main) · last worked 14h ago · Claude said done, 2 tests still failing',
  );
  expect(said([t2, lint])).toBe(
    'myapp (main) · last worked 14h ago · Claude said done, 1 test and 1 other problem still failing',
  );
  expect(said([], ['1 uncommitted file'])).toBe(
    'myapp (main) · last worked 14h ago · Claude said done, 1 uncommitted file',
  );
});

test('without a claim, the next step carries what else is open', () => {
  const out = render([
    entry({
      openProblems: [problem('boom', 'make'), problem('bang', 'make deploy')],
      uncommittedCount: 2,
      nextStep: 'Get `make` working (boom)',
    }),
  ]);
  expect(out).toContain(
    '  Next: Get `make` working (boom) (also: 1 more problem, 2 uncommitted files)',
  );
});

test('no branch → name only; stale and an unreadable git status are flagged', () => {
  expect(header(entry({ branch: null, uncommittedCount: 1 }))).toBe('myapp · last worked 14h ago');
  expect(header(entry({ stale: true, uncommittedCount: 1 }))).toBe(
    'myapp (main) · last worked 14h ago · stale',
  );
  expect(header(entry({ gitUnavailable: true }))).toBe(
    'myapp (main) · last worked 14h ago · git status unavailable',
  );
});

test('at most 3 lines per project, each at most 100 characters; the counts survive', () => {
  const long = problem(`npm error ${'x'.repeat(200)}`, 'npm run lint');
  const out = render([
    entry({
      project: { root: '/w/x', name: `Very-Long-Project-Name-${'y'.repeat(60)}` },
      claimedDone: claim(`All done ${'y'.repeat(200)}`, [contradictionOf(long)]),
      openProblems: [long, problem('z', 'make')],
      workingOn: `working on ${'z'.repeat(200)}`,
      nextStep: `Fix the lint errors (${'q'.repeat(200)})`,
      uncommittedCount: 4,
    }),
  ]);
  const lines = out.split('\n').slice(2, -2);
  expect(lines).toHaveLength(3);
  for (const l of lines) expect([...l].length).toBeLessThanOrEqual(100);
  expect(lines[0]).toMatch(/· Claude said done, 1 problem still failing$/);
  expect(lines[2]).toMatch(/\(also: 1 more problem, 4 uncommitted files\)$/);
});

test('with color, the text is the same once the ANSI codes are removed', () => {
  const colored = renderLooseEnds(sample(), NOW, { color: true });
  // eslint-disable-next-line no-control-regex -- matching ANSI color codes is the point
  expect(colored).toMatch(/\x1b\[/);
  // eslint-disable-next-line no-control-regex -- matching ANSI color codes is the point
  expect(colored.replace(/\x1b\[[0-9;]*m/g, '')).toBe(render(sample()));
});

test('a long next step loses its trailing bracket before anything is cut', () => {
  const out = render([
    entry({
      openProblems: [problem('SMTP connection refused', 'python scripts/send_test_email.py')],
      uncommittedCount: 1,
      nextStep: 'Get `python scripts/send_test_email.py` working (SMTP connection refused)',
    }),
  ]);
  expect(out).toContain(
    '  Next: Get `python scripts/send_test_email.py` working (also: 1 uncommitted file)\n',
  );
});

test('the project name and branch are never cut for the flags; long flags are cut at the end', () => {
  const t = problem('a', 'npm test', true);
  const out = header(
    entry({
      project: { root: '/w/leftoff', name: 'leftoff' },
      claimedDone: claim('Done.', [contradictionOf(t), '32 uncommitted files']),
      openProblems: [t],
      stale: true,
    }),
  ) as string;
  expect(
    out.startsWith('leftoff (main) · last worked 14h ago · Claude said done, 1 test still failing'),
  ).toBe(true);
  expect([...out].length).toBeLessThanOrEqual(100);
});
