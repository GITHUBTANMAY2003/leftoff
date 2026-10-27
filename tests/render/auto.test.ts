import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import type { BriefFacts, OpenProblem } from '../../src/brief/facts.ts';
import { renderAutoBrief } from '../../src/render/auto.ts';
import { RAHUL_NOW, rahulFacts } from './helpers.ts';

const golden = (name: string) => readFileSync(join(import.meta.dirname, 'golden', name), 'utf8');
const render = (f: BriefFacts) => renderAutoBrief(f, { color: false, now: RAHUL_NOW });

// The next step for Rahul is "Resolve: <the top problem>", so it is not repeated.
test('auto brief matches golden for rahul scenario', () => {
  expect(render(rahulFacts()) + '\n').toBe(golden('rahul-auto.txt'));
});

const problem = (n: number): OpenProblem => ({
  error: `error ${n} ${'x'.repeat(120)}`,
  command: `make step${n}`,
  isTest: false,
  source: 'shell',
  firstSeen: '2026-10-20T18:00:00.000Z',
  attempts: [],
});

test('auto brief ≤ 8 lines with exact first and last lines, each line ≤ 100 chars', () => {
  const f: BriefFacts = {
    ...rahulFacts(),
    unfinished: {
      files: [1, 2, 3].map((n) => ({ path: `f${n}.ts`, status: 'modified' })),
      diffStat: null,
    },
    openProblems: [problem(1), problem(2), problem(3)],
    notes: ['a note', 'another'],
    nextStep: 'Write the migration for reset tokens',
  };
  const lines = render(f).split('\n');
  expect(lines.length).toBeLessThanOrEqual(8);
  expect(lines[0]).toBe(
    'Where you left off — myapp (feature/forgot-password) · last active 14h ago',
  );
  expect(lines.at(-1)).toBe('Run `leftoff resume` for details');
  expect(lines).toContain('  • 3 uncommitted files');
  expect(lines.find((l) => l.startsWith('  ✗ `make step1`'))).toMatch(/… \(\+2 more problems\)$/);
  expect(lines).toContain('  → Write the migration for reset tokens');
  for (const l of lines) expect([...l].length).toBeLessThanOrEqual(100);
});

test('auto brief with nothing open: header and last line only', () => {
  const f: BriefFacts = {
    ...rahulFacts(),
    unfinished: { files: [], diffStat: null },
    openProblems: [],
    nextStep: null,
  };
  expect(render(f).split('\n')).toEqual([
    'Where you left off — myapp (feature/forgot-password) · last active 14h ago',
    'Run `leftoff resume` for details',
  ]);
});

test('color only bolds the first line', () => {
  const out = renderAutoBrief(rahulFacts(), { color: true, now: RAHUL_NOW });
  expect(out.split('\n')[0]).toBe(
    '\x1b[1mWhere you left off — myapp (feature/forgot-password) · last active 14h ago\x1b[0m',
  );
  expect(out.split('\n').slice(1).join('\n')).not.toContain('\x1b[');
});

test('the problem shown is the one the next step verifies, and the next step is not repeated', () => {
  const f: BriefFacts = {
    ...rahulFacts(),
    openProblems: [problem(1), { ...problem(2), error: 'boom' }],
    nextStep: 'Verify: `make step2` still failing',
  };
  const lines = render(f).split('\n');
  expect(lines).toContain('  ✗ `make step2` — boom (+1 more problem)');
  expect(lines.join('\n')).not.toContain('Verify:');
  // A next step about something else stays.
  const other = render({ ...f, nextStep: 'Verify: 2 uncommitted files' }).split('\n');
  expect(other).toContain('  → Verify: 2 uncommitted files');
});

test('a long command is shortened from the middle so the error shows on the one problem line', () => {
  const cmd =
    'cargo test -p looplint_adapters --test openai_agents -- qualified_and_aliased run_agent_that_is star_import';
  const f: BriefFacts = {
    ...rahulFacts(),
    openProblems: [
      { ...problem(1), command: cmd, error: 'test result: FAILED. 3 passed; 1 failed' },
      problem(2),
    ],
    nextStep: null,
  };
  const line = render(f)
    .split('\n')
    .find((l) => l.startsWith('  ✗')) as string;
  expect([...line].length).toBeLessThanOrEqual(100);
  expect(line).toMatch(
    /^ {2}✗ `cargo test … .*star_import` — test result: FAILED.*\(\+1 more problem\)$/,
  );
});
