import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import type { FileChange } from '../../src/brief/changes.ts';
import type { BriefFacts, OpenProblem } from '../../src/brief/facts.ts';
import { describeChanges } from '../../src/brief/story.ts';
import { renderStory } from '../../src/render/story.ts';
import { RAHUL_NOW, rahulFacts } from './helpers.ts';

// `leftoff resume`: exactly three sections — What you did, Files you changed,
// What's left — from the developer's own words, no LLM (owner decision after 15e).

const golden = (name: string) => readFileSync(join(import.meta.dirname, 'golden', name), 'utf8');
const change = (
  path: string,
  status: FileChange['status'],
  added: string[],
  removed: string[] = [],
): FileChange => ({
  path,
  status,
  added,
  removed,
});
const problem = (command: string, error: string, attempts: string[] = []): OpenProblem => ({
  error,
  command,
  isTest: false,
  source: 'codex',
  firstSeen: '2026-10-20T18:00:00.000Z',
  attempts,
});

function vecstore(): { facts: BriefFacts; changes: FileChange[] } {
  const base = rahulFacts();
  const collect = problem('make run-ci', 'ERROR collecting tests/test_kernel.py', [
    'cat tests/test_store.py',
  ]);
  const format = problem(
    'uv run --no-sync ruff format --check src/app/a.py src/app/b.py tests/t.py',
    'Would reformat: src/app/a.py',
  );
  return {
    facts: {
      ...base,
      project: { root: '/w/vecstore', name: 'vecstore' },
      branch: 'fix/issue-15-store-error-mapping',
      unfinished: { files: [], diffStat: null },
      openProblems: [collect, format],
      claimedDone: {
        source: 'codex',
        message: 'The fix is done.',
        at: '2026-10-20T18:30:00.000Z',
        contradictions: ['`make run-ci` — ERROR collecting tests/test_kernel.py (still failing)'],
      },
      work: { ...base.work, workingOn: 'fixing issue #15: store error mapping' },
    },
    changes: [
      change(
        'tests/test_store_errors.py',
        'new',
        Array.from({ length: 9 }, (_, i) => `def test_case_${i}():`),
      ),
      change(
        'src/app/stores/blob.py',
        'edited',
        ['from ._store_errors import translate_errors'],
        ['x'],
      ),
      change('src/app/exceptions.py', 'edited', [
        'class AccessDeniedError(AppError):',
        'class ThrottledError(AppError):',
      ]),
      change('src/app/stores/_store_errors.py', 'new', [
        '"""Shared error translation for blob store calls."""',
        'def translate_errors():',
      ]),
      change('src/app/stores/async_blob.py', 'edited', ['    with translate_errors():']),
    ],
  };
}
const render = (facts: BriefFacts, changes: FileChange[] | null, details = false) =>
  renderStory(facts, changes === null ? null : describeChanges(changes), {
    color: false,
    now: RAHUL_NOW,
    details,
  });

test('three sections, from the diff and the facts (golden)', () => {
  const { facts, changes } = vecstore();
  expect(render(facts, changes) + '\n').toBe(golden('story-brief.txt'));
});

test('--details: the same three sections, each problem with its error line, short commands and attempts', () => {
  const { facts, changes } = vecstore();
  const out = render(facts, changes, true);
  expect(out).toContain(
    [
      "    • CI fails: pytest can't load test_kernel.py",
      '      Error: ERROR collecting tests/test_kernel.py',
      '      Command: make run-ci',
      '      Already tried: reading tests/test_store.py',
      '    • 3 files need formatting',
      '      Error: Would reformat: src/app/a.py',
      '      Command: ruff format --check (3 files)',
      '      Nothing tried yet.',
    ].join('\n'),
  );
  expect(out.split('\n').filter((l) => /^ {2}\S/.test(l))).toEqual([
    '  What you did',
    '  Files you changed',
    "  What's left",
  ]);
});

test('nothing left: all committed and passing; an unanswered question is listed', () => {
  const { facts, changes } = vecstore();
  const clean: BriefFacts = {
    ...facts,
    openProblems: [],
    claimedDone: null,
    lastAgent: { source: 'claude', update: 'Done.', question: 'Should I push?' },
  };
  const out = render(clean, changes);
  expect(out).toContain(
    "    • Claude asked: Should I push?\n    Start here: answer Claude's question: Should I push?",
  );
  const none = render({ ...clean, lastAgent: null }, changes);
  expect(none).toContain('    • Nothing failing, all changes committed');
});

test('uncommitted work is listed; without a diff the files section is left out', () => {
  const { facts } = vecstore();
  const out = render(
    {
      ...facts,
      openProblems: [],
      claimedDone: null,
      unfinished: { files: [{ path: 'a.py', status: 'modified' }], diffStat: null },
    },
    null,
  );
  expect(out).not.toContain('Files you changed');
  expect(out).toContain('    • 1 uncommitted file');
});

test('every line fits 100 characters and nothing is cut', () => {
  const { facts, changes } = vecstore();
  for (const l of render(facts, changes, true).split('\n')) {
    expect([...l].length).toBeLessThanOrEqual(100);
    expect(l).not.toMatch(/…$/);
  }
});

test('a command with one file argument stays whole; several become a count', () => {
  const { facts } = vecstore();
  const out = render(
    { ...facts, claimedDone: null, openProblems: [problem('python scripts/send.py', 'refused')] },
    null,
    true,
  );
  expect(out).toContain('      Command: python scripts/send.py');
});

test('files shown: 4 after small work, 6 after medium, 8 after large; --details always up to 8', () => {
  const many = Array.from({ length: 10 }, (_, i) =>
    change(`src/m${i}.py`, 'edited', [`def f${i}():`]),
  );
  const { facts } = vecstore();
  const count = (size: BriefFacts['work']['size'], details = false) =>
    render({ ...facts, work: { ...facts.work, size } }, many, details)
      .split('\n')
      .filter((l) => /^ {4}• m\d\.py/.test(l)).length;
  expect([count('small'), count('medium'), count('large'), count('small', true)]).toEqual([
    4, 6, 8, 8,
  ]);
});
