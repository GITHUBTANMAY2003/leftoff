import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import type { BriefFacts, OpenProblem } from '../../src/brief/facts.ts';
import { renderAutoBrief } from '../../src/render/auto.ts';
import { RAHUL_NOW, rahulFacts } from './helpers.ts';

// The automatic brief on terminal open: the narrative (Task 15b), then the
// pointer to `leftoff resume`.

const golden = (name: string) => readFileSync(join(import.meta.dirname, 'golden', name), 'utf8');
const render = (f: BriefFacts, polished: string | null = null) =>
  renderAutoBrief(f, { color: false, now: RAHUL_NOW, polished });

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

test('auto brief: exact first and last lines, every line ≤ 100 chars, extra problems counted', () => {
  const f: BriefFacts = {
    ...rahulFacts(),
    unfinished: {
      files: [1, 2, 3].map((n) => ({ path: `f${n}.ts`, status: 'modified' })),
      diffStat: null,
    },
    openProblems: [problem(1), problem(2), problem(3)],
  };
  const lines = render(f).split('\n');
  expect(lines[0]).toBe('myapp · 14h ago · branch feature/forgot-password');
  expect(lines.at(-1)).toBe('Run `leftoff resume` for details');
  expect(lines).toContain('  Still open: 2 more problems · 3 uncommitted files');
  expect(lines.find((l) => l.startsWith('  It stopped with: `make step1`'))).toBeDefined();
  for (const l of lines) expect([...l].length).toBeLessThanOrEqual(100);
});

test('a cached polished summary is shown first, right after the first line', () => {
  const lines = render(rahulFacts(), 'Rahul was adding password reset; SMTP still refuses.').split(
    '\n',
  );
  expect(lines[1]).toBe('  Rahul was adding password reset; SMTP still refuses.');
  expect(lines[2]).toMatch(/^ {2}You asked:/);
});

test('color only bolds the first line', () => {
  const out = renderAutoBrief(rahulFacts(), { color: true, now: RAHUL_NOW });
  expect(out.split('\n')[0]).toBe('\x1b[1mmyapp · 14h ago · branch feature/forgot-password\x1b[0m');
  expect(out.split('\n').slice(1).join('\n')).not.toContain('\x1b[');
});

test('a long command is shortened from the middle so the error shows', () => {
  const cmd =
    'cargo run -p billing_adapters --bin openai_agents -- qualified_and_aliased run_agent_that_is star_import';
  const f: BriefFacts = {
    ...rahulFacts(),
    openProblems: [
      { ...problem(1), command: cmd, error: 'thread main panicked at index out of bounds' },
    ],
  };
  const line = render(f)
    .split('\n')
    .find((l) => l.startsWith('  It stopped with:')) as string;
  expect([...line].length).toBeLessThanOrEqual(100);
  expect(line).toMatch(/`cargo run … .*star_import` — thread main panicked/);
});

// ---- after 15b (owner answer 3): the auto brief shows at most 2 sentences of polish ----

test('the auto brief shows at most two sentences (~200 chars) of the polished summary', () => {
  const polished =
    'Rahul was adding password reset. SMTP refuses connections on both ports. He tried port 587 and no TLS.';
  expect(render(rahulFacts(), polished).split('\n')[1]).toBe(
    '  Rahul was adding password reset. SMTP refuses connections on both ports.',
  );
  const long = `${'A very long first sentence with many words in it '.repeat(6)}ends here. Second one.`;
  const shown = render(rahulFacts(), long).split('\n')[1] as string;
  expect([...shown.trim()].length).toBeLessThanOrEqual(200);
  expect(shown.endsWith('…')).toBe(true);
});
