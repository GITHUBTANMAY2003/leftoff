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

const NOW = new Date('2026-10-21T08:30:00.000Z');
const golden = (name: string) => readFileSync(join(import.meta.dirname, 'golden', name), 'utf8');

const problem = (
  error: string,
  command: string | null,
  isTest = false,
  attempts: string[] = [],
): OpenProblem => ({
  error,
  command,
  isTest,
  source: 'claude',
  firstSeen: '2026-10-20T17:00:00.000Z',
  attempts,
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
  ...over,
});

const PYTEST = problem('1 failed, 4 passed', 'pytest tests/test_reset.py', true, [
  'Edited reset.py',
]);
const SMTP = problem('SMTP connection refused', null, false, ['changed port', 'disabled TLS']);

function sample(): LooseEnds[] {
  return [
    entry({
      branch: 'feature/forgot-password',
      claimedDone: claim('All tests pass', [contradictionOf(PYTEST)]),
      openProblems: [PYTEST, SMTP],
      uncommittedCount: 1,
    }),
    entry({
      project: { root: '/w/api-server', name: 'api-server' },
      lastActiveAt: '2026-10-17T08:30:00.000Z',
      stale: true,
      uncommittedCount: 3,
    }),
  ];
}

const render = (items: LooseEnds[]) => renderLooseEnds(items, NOW, { color: false });
const bang = (cd: ClaimedDone, openProblems: OpenProblem[]) =>
  render([entry({ claimedDone: cd, openProblems })])
    .split('\n')
    .find((l) => l.startsWith('  !'));

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

test('the "Agent said" line counts tests and other problems', () => {
  const t2 = problem('a', 'npm test', true);
  const t3 = problem('b', 'npm run e2e', true);
  const lint = problem('c', 'npm run lint');
  const build = problem('d', 'npm run build');
  const said = (ps: OpenProblem[], extra: string[] = []) =>
    bang(claim('Done.', [...ps.map(contradictionOf), ...extra]), ps);
  expect(said([t2, t3])).toBe('  ! Agent said "Done." — 2 tests still failing');
  expect(said([lint])).toBe('  ! Agent said "Done." — 1 problem still failing');
  expect(said([lint, build])).toBe('  ! Agent said "Done." — 2 problems still failing');
  expect(said([t2, lint])).toBe(
    '  ! Agent said "Done." — 1 test and 1 other problem still failing',
  );
  expect(said([t2, t3, lint, build])).toBe(
    '  ! Agent said "Done." — 2 tests and 2 other problems still failing',
  );
  expect(said([t2], ['3 uncommitted files'])).toBe(
    '  ! Agent said "Done." — 1 test still failing · 3 uncommitted files',
  );
  expect(said([], ['1 uncommitted file'])).toBe('  ! Agent said "Done." — 1 uncommitted file');
});

test('problems behind the "Agent said" line are still listed', () => {
  const out = render(sample());
  expect(out).toContain('  ✗ `pytest tests/test_reset.py` — 1 failed, 4 passed (1 attempt)');
});

test('a problem with no attempts has no count; no branch → name only', () => {
  const out = render([entry({ branch: null, openProblems: [problem('boom', 'make')] })]);
  expect(out.split('\n')[2]).toBe('myapp · 14h ago');
  expect(out).toContain('  ✗ `make` — boom\n');
});

test('git status unavailable is shown instead of dropping the project', () => {
  expect(render([entry({ gitUnavailable: true })])).toContain(
    'myapp (main) · 14h ago\n  ? git status unavailable\n',
  );
});

test('long lines are cut to 100 characters, keeping the counts at the end', () => {
  const long = problem(`npm error ${'x'.repeat(200)}`, 'npm run lint', false, ['a', 'b']);
  const out = render([
    entry({
      claimedDone: claim(`All done ${'y'.repeat(200)}`, [contradictionOf(long)]),
      openProblems: [long],
    }),
  ]);
  const lines = out.split('\n');
  for (const l of lines) expect([...l].length).toBeLessThanOrEqual(100);
  expect(lines.find((l) => l.startsWith('  !'))).toMatch(
    /^ {2}! Agent said "All done y+…" — 1 problem still failing$/,
  );
  expect(lines.find((l) => l.startsWith('  ✗'))).toMatch(
    /^ {2}✗ `npm run lint` — npm error x+… \(2 attempts\)$/,
  );
});

test('with color, the text is the same once the ANSI codes are removed', () => {
  const colored = renderLooseEnds(sample(), NOW, { color: true });
  // eslint-disable-next-line no-control-regex -- matching ANSI color codes is the point
  expect(colored).toMatch(/\x1b\[/);
  // eslint-disable-next-line no-control-regex -- matching ANSI color codes is the point
  expect(colored.replace(/\x1b\[[0-9;]*m/g, '')).toBe(render(sample()));
});

test('a long command is shortened from the middle so the error stays on the line (owner decision after Task 14)', () => {
  const cmd =
    'cargo test -p looplint_adapters --test openai_agents -- qualified_and_aliased run_agent_that_is star_import';
  const out = renderLooseEnds(
    [
      entry({
        openProblems: [problem('test result: FAILED. 3 passed; 1 failed', cmd, true, ['a'])],
      }),
    ],
    NOW,
    { color: false },
  );
  const line = out.split('\n').find((l) => l.startsWith('  ✗')) as string;
  expect([...line].length).toBeLessThanOrEqual(100);
  expect(line).toContain('` — test result: FAILED');
  expect(line).toMatch(/^ {2}✗ `cargo test … .*star_import` — /);
  expect(line.endsWith('(1 attempt)')).toBe(true);
});
