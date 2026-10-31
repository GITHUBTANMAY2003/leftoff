import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import type { BriefFacts, OpenProblem } from '../../src/brief/facts.ts';
import { narrativeLines, renderBrief } from '../../src/render/narrative.ts';
import { RAHUL_NOW, rahulFacts } from './helpers.ts';

// The narrative brief (Task 15b C): deterministic plain words, no AI.

const golden = (name: string) => readFileSync(join(import.meta.dirname, 'golden', name), 'utf8');
const lines = (f: BriefFacts, polished: string | null = null) =>
  narrativeLines(f, polished, { now: RAHUL_NOW, width: null });

const problem = (command: string, error: string, isTest = false): OpenProblem => ({
  error,
  command,
  isTest,
  source: 'claude',
  firstSeen: '2026-10-20T18:00:00.000Z',
  attempts: [],
});
const clean = (f: BriefFacts): BriefFacts => ({
  ...f,
  unfinished: { files: [], diffStat: null },
  openProblems: [],
  claimedDone: null,
  nextStep: null,
});

test('the resume brief for the §1.1 scenario (golden)', () => {
  expect(renderBrief(rahulFacts(), null, { color: false, now: RAHUL_NOW }) + '\n').toBe(
    golden('rahul-brief.txt'),
  );
});

test('"Agent said done, but…" is one sentence in plain words, and its problem is not repeated', () => {
  const f: BriefFacts = {
    ...rahulFacts(),
    openProblems: [
      problem('cargo test -p billing_adapters', 'test result: FAILED', true),
      problem('npm run lint', 'npm error Missing script: "lint"'),
      problem('./deploy.sh', 'connection refused'),
    ],
    claimedDone: {
      source: 'claude',
      message: 'All tests pass',
      at: '2026-10-20T18:30:00.000Z',
      contradictions: [
        '`cargo test -p billing_adapters` — test result: FAILED (still failing)',
        '`npm run lint` — npm error Missing script: "lint" (still failing)',
      ],
    },
  };
  const out = lines(f);
  expect(out).toContain(
    'Claude said "All tests pass", but the billing_adapters tests are still failing.',
  );
  expect(out.some((l) => l.startsWith('It stopped with:'))).toBe(false);
  expect(out).toContain('Still open: 2 more problems · 1 uncommitted file');
  expect(out).toContain(
    'Pick up with: Make the billing_adapters tests pass (`cargo test -p billing_adapters`)',
  );
});

test('a commit claim with uncommitted files reads as a sentence too', () => {
  const f: BriefFacts = {
    ...rahulFacts(),
    openProblems: [],
    claimedDone: {
      source: 'codex',
      message: 'Committed the fix',
      at: '2026-10-20T18:30:00.000Z',
      contradictions: ['1 uncommitted file'],
    },
  };
  const out = lines(f);
  expect(out).toContain('Codex said "Committed the fix", but 1 file is still uncommitted.');
  expect(out).toContain('Pick up with: Commit the 1 file Codex said was committed');
});

test("the agent's final question is the next step", () => {
  const f: BriefFacts = {
    ...clean(rahulFacts()),
    lastAgent: { source: 'claude', update: 'The cache is in.', question: 'Should I push?' },
  };
  const out = lines(f);
  expect(out).toContain("Claude's last update: The cache is in.");
  expect(out).toContain("Pick up with: Answer Claude's question: Should I push?");
});

test('nothing open after commits: all changes committed, start the next task', () => {
  const out = lines(clean(rahulFacts()));
  expect(out).toContain('Still open: nothing, all changes committed');
  expect(out).toContain(
    'Pick up with: Start the next task (everything from the last session is committed)',
  );
});

test('uncommitted files without problems: review and commit them', () => {
  const f: BriefFacts = {
    ...clean(rahulFacts()),
    done: [],
    unfinished: {
      files: ['a.ts', 'b.ts', 'c.ts', 'd.ts'].map((path) => ({ path, status: 'modified' })),
      diffStat: null,
    },
  };
  const out = lines(f);
  expect(out).toContain('Still open: 4 uncommitted files');
  expect(out).toContain(
    'Pick up with: Review and commit 4 uncommitted files (a.ts, b.ts, c.ts and 1 more)',
  );
  expect(out.some((l) => l.startsWith('Done:'))).toBe(false);
});

test('a "next:" note wins; done shows the two newest commits and then a count', () => {
  const f: BriefFacts = {
    ...rahulFacts(),
    done: ['feat: a', 'feat: b', 'feat: c', 'Edited 2 files: x.ts, y.ts'],
    notes: ['next: write the migration'],
  };
  const out = lines(f);
  expect(out).toContain('Done: feat: c · feat: b (+2 more)');
  expect(out).toContain('Pick up with: write the migration');
});

test('a polished summary comes first, right after the first line', () => {
  const out = lines(rahulFacts(), 'Rahul was building password reset; SMTP refuses connections.');
  expect(out[1]).toBe('Rahul was building password reset; SMTP refuses connections.');
  expect(out[2]).toMatch(/^You asked:/);
});

test('terminal lines are cut to 100 characters, the error of a problem stays visible', () => {
  const f: BriefFacts = {
    ...rahulFacts(),
    lastIntent: 'word '.repeat(60).trim(),
    openProblems: [
      problem(`./tools/${'deep/'.repeat(20)}run.sh --all`, 'connection refused by host'),
    ],
  };
  const out = renderBrief(f, null, { color: false, now: RAHUL_NOW }).split('\n');
  for (const l of out) expect([...l].length).toBeLessThanOrEqual(100);
  expect(out.find((l) => l.includes('It stopped with:'))).toContain('connection refused by host');
});

test('first line without a branch, and with no git', () => {
  const f: BriefFacts = { ...rahulFacts(), branch: null };
  expect(lines(f)[0]).toBe('myapp · 14h ago');
});

test('only the first line is bold with color', () => {
  const out = renderBrief(rahulFacts(), null, { color: true, now: RAHUL_NOW }).split('\n');
  expect(out[0]).toBe('\x1b[1mmyapp · 14h ago · branch feature/forgot-password\x1b[0m');
  expect(out.slice(1).join('\n')).not.toContain('\x1b[');
});

test('every note is shown (P11); the newest "next:" note is the next step instead', () => {
  const f: BriefFacts = { ...rahulFacts(), notes: ['creds are in 1Password', 'next: ask ops'] };
  const out = lines(f);
  expect(out).toContain('Note: creds are in 1Password');
  expect(out).not.toContain('Note: next: ask ops');
  expect(out.at(-1)).toBe('Pick up with: ask ops');
});

test('a long claim is shortened inside the quote, so "but …" stays on the line', () => {
  const f: BriefFacts = {
    ...rahulFacts(),
    openProblems: [problem('cargo test -p billing_adapters', 'test result: FAILED', true)],
    claimedDone: {
      source: 'claude',
      message: `…${'the plan records exactly where to pick up '.repeat(3)}and it is done.`,
      at: '2026-10-20T18:30:00.000Z',
      contradictions: ['`cargo test -p billing_adapters` — test result: FAILED (still failing)'],
    },
  };
  const line = renderBrief(f, null, { color: false, now: RAHUL_NOW })
    .split('\n')
    .find((l) => l.includes(' said "')) as string;
  expect([...line].length).toBeLessThanOrEqual(100);
  expect(line).toMatch(/…", but the billing_adapters tests are still failing\.$/);
});

// ---- after 15b (owner answer 5): "You asked" is the first sentence, about 100 chars ----

test('"You asked" shows the first sentence of the request', () => {
  const f: BriefFacts = {
    ...rahulFacts(),
    lastIntent: 'Task 3 approved. Now add the cache and a test.',
  };
  expect(lines(f)).toContain('You asked: Task 3 approved.');
});

test('leading @file mentions are skipped; a long first sentence is cut at a word, ~100 chars', () => {
  const f: BriefFacts = {
    ...rahulFacts(),
    lastIntent: `@docs/plan.md @docs/PROGRESS.md We are continuing ${'the build again '.repeat(10)}today. Second.`,
  };
  const line = lines(f).find((l) => l.startsWith('You asked: ')) as string;
  const asked = line.slice('You asked: '.length);
  expect(asked.startsWith('We are continuing the build')).toBe(true);
  expect([...asked].length).toBeLessThanOrEqual(100);
  expect(asked.endsWith('…')).toBe(true);
  expect(asked).not.toMatch(/ \S{1,3}…$/); // not a half word
});
