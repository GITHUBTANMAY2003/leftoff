import { expect, test } from 'vitest';
import type { BriefFacts, ClaimedDone, OpenProblem } from '../../src/brief/facts.ts';
import { chooseNextStep } from '../../src/brief/next-step.ts';

function facts(partial: Partial<Omit<BriefFacts, 'nextStep'>>): Omit<BriefFacts, 'nextStep'> {
  return {
    project: { root: '/p', name: 'p' },
    branch: null,
    lastActiveAt: null,
    window: { from: '2026-10-20T10:00:00.000Z', to: '2026-10-20T11:00:00.000Z' },
    done: [],
    unfinished: { files: [], diffStat: null },
    lastIntent: null,
    lastAgentMessage: null,
    openProblems: [],
    claimedDone: null,
    notes: [],
    sources: [],
    ...partial,
  };
}
const op = (error: string, command: string | null = null): OpenProblem => ({
  error,
  command,
  isTest: false,
  source: 'claude',
  firstSeen: '2026-10-20T10:00:00.000Z',
  attempts: [],
});
const cd = (contradictions: string[]): ClaimedDone => ({
  source: 'claude',
  message: 'All tests pass',
  at: '2026-10-20T10:00:00.000Z',
  contradictions,
});
const files = (paths: string[]) => ({
  files: paths.map((path) => ({ path, status: 'modified' })),
  diffStat: null,
});

test.each([
  ['note next: wins', { notes: ['next: try OAuth app password'] }, 'try OAuth app password'],
  [
    'claimed done next',
    { claimedDone: cd(['1 test still failing']) },
    'Verify: 1 test still failing',
  ],
  [
    'open problem next',
    { openProblems: [op('SMTP connection refused')] },
    'Resolve: SMTP connection refused',
  ],
  [
    'unfinished files',
    { unfinished: files(['a.py', 'b.py', 'c.py']) },
    'Finish and commit changes in a.py and 2 more',
  ],
  ['last intent', { lastIntent: 'add rate limiting' }, 'Continue: add rate limiting'],
  ['nothing', {}, null],
] as const)('next step: %s', (_n, partial, expected) =>
  expect(chooseNextStep(facts(partial as Partial<BriefFacts>))).toBe(expected),
);

test('each rule beats the ones after it', () => {
  const all = {
    notes: ['remember the API key rotation', 'next: ask ops about the SMTP relay'],
    claimedDone: cd(['SMTP connection refused (still failing)']),
    openProblems: [op('SMTP connection refused')],
    unfinished: files(['a.py']),
    lastIntent: 'fix email',
  };
  expect(chooseNextStep(facts(all))).toBe('ask ops about the SMTP relay');
  expect(chooseNextStep(facts({ ...all, notes: [] }))).toBe(
    'Verify: SMTP connection refused (still failing)',
  );
  expect(chooseNextStep(facts({ ...all, notes: [], claimedDone: null }))).toBe(
    'Resolve: SMTP connection refused',
  );
  expect(chooseNextStep(facts({ unfinished: files(['a.py']), lastIntent: 'x' }))).toBe(
    'Finish and commit changes in a.py',
  );
});

test('the newest note starting with next: wins; the prefix is case-insensitive', () => {
  expect(
    chooseNextStep(facts({ notes: ['next: old plan', 'Next: newer plan', 'unrelated'] })),
  ).toBe('newer plan');
});

test('the first open problem in the list (the newest) is the one to resolve', () => {
  expect(chooseNextStep(facts({ openProblems: [op('newest'), op('older')] }))).toBe(
    'Resolve: newest',
  );
});

test('a contradiction from a failing command is verified by that command', () => {
  const lint = op('Missing script: "lint"', 'npm run lint');
  expect(
    chooseNextStep(
      facts({
        openProblems: [lint],
        claimedDone: cd(['`npm run lint` — Missing script: "lint" (still failing)']),
      }),
    ),
  ).toBe('Verify: `npm run lint` still failing');
});

test('an open problem from a command is resolved with the command first', () => {
  expect(
    chooseNextStep(facts({ openProblems: [op('Missing script: "lint"', 'npm run lint')] })),
  ).toBe('Resolve: `npm run lint` — Missing script: "lint"');
});
