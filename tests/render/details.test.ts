import { expect, test } from 'vitest';
import type { BriefFacts, OpenProblem } from '../../src/brief/facts.ts';
import { renderDetails } from '../../src/render/details.ts';
import { RAHUL_NOW, rahulFacts } from './helpers.ts';

// `leftoff resume --details` (dogfooding after Task 15c): the same plain words
// as the brief, with every open problem as a numbered block. Raw data stays in
// --json.

const problem = (
  command: string | null,
  error: string,
  attempts: string[] = [],
  isTest = false,
): OpenProblem => ({
  error,
  command,
  isTest,
  source: 'codex',
  firstSeen: '2026-10-20T18:00:00.000Z',
  attempts,
});
const render = (f: BriefFacts) =>
  renderDetails(f, null, { color: false, now: RAHUL_NOW }).split('\n');

function sample(): BriefFacts {
  const collect = problem('make run-ci', 'ERROR collecting tests/test_kernel.py', [
    'cat tests/test_store.py',
    'git diff --check',
  ]);
  const format = problem(
    'uv run ruff format --check tests/test_errors.py src/app/stores/s3.py',
    'Would reformat: tests/test_errors.py',
    ['Edited src/app/exceptions.py', 'uv run pytest tests/test_errors.py'],
  );
  return {
    ...rahulFacts(),
    project: { root: '/w/vecstore', name: 'vecstore' },
    branch: 'fix/issue-15-error-mapping',
    openProblems: [collect, format],
    claimedDone: {
      source: 'codex',
      message: 'The fix and its 51 tests are done.',
      at: '2026-10-20T18:30:00.000Z',
      contradictions: ['`make run-ci` — ERROR collecting tests/test_kernel.py (still failing)'],
    },
    unfinished: { files: [], diffStat: null },
    work: {
      ...rahulFacts().work,
      size: 'small',
      commits: [],
      filesChanged: 6,
      topFolders: [
        { path: 'src/app', files: 4 },
        { path: 'tests', files: 2 },
      ],
      workingOn: 'fixing error mapping (issue 15)',
    },
  };
}

test('the sized header, what you were doing, how many things are not right', () => {
  const out = render(sample());
  expect(out[0]).toMatch(/^vecstore · last worked 14h ago · .*branch fix\/issue-15-error-mapping$/);
  expect(out).toContain('  You were fixing error mapping (issue 15).');
  expect(out).toContain(
    '  Codex said "The fix and its 51 tests are done." 2 things are still not right:',
  );
});

test('each open problem is a numbered block: words, error, command, files, attempts in words', () => {
  const out = render(sample()).join('\n');
  expect(out).toContain(
    [
      '  1. `make run-ci` fails',
      '     Error: ERROR collecting tests/test_kernel.py',
      '     Command: make run-ci',
      '     Already tried: reading test_store.py, checking the diff',
    ].join('\n'),
  );
  expect(out).toContain(
    [
      '  2. Ruff finds unformatted files',
      '     Error: Would reformat: tests/test_errors.py',
      '     Command: uv run ruff format --check tests/test_errors.py src/app/stores/s3.py',
      '     Files: src/app/stores/s3.py, tests/test_errors.py',
      '     Already tried: editing exceptions.py, running the errors tests',
    ].join('\n'),
  );
});

test('then what changed and the next step; no raw sections or sources line', () => {
  const out = render(sample());
  expect(out).toContain('  What changed: 6 files, most in src/app and tests');
  expect(out.at(-1)).toMatch(/^ {2}Next: /);
  expect(out.join('\n')).not.toMatch(/Sources:|^Open problems$|^ {4}tried:/m);
});

test('no problems: says nothing is failing; uncommitted files are listed', () => {
  const f: BriefFacts = {
    ...sample(),
    openProblems: [],
    claimedDone: null,
    unfinished: {
      files: [
        { path: 'a.py', status: 'modified' },
        { path: 'b.py', status: 'untracked' },
      ],
      diffStat: null,
    },
  };
  const out = render(f);
  expect(out).toContain('  Nothing is failing.');
  expect(out).toContain('  Uncommitted: a.py (modified), b.py (untracked)');
});

test('a problem whose words already include the error has no separate Error line', () => {
  const out = render({
    ...sample(),
    claimedDone: null,
    openProblems: [problem('./deploy.sh', 'connection refused')],
  });
  expect(out).toContain('  1. `./deploy.sh` — connection refused');
  expect(out.some((l) => l.includes('Error:'))).toBe(false);
});
