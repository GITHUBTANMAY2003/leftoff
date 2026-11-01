import { expect, test } from 'vitest';
import type { FileChange } from '../../src/brief/changes.ts';
import { builtSentence, describeChanges } from '../../src/brief/story.ts';

// "Files you changed" and "what was built", from the diff alone.

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

function vecstore(): FileChange[] {
  return [
    change('tests/test_store_errors.py', 'new', [
      'from app.stores._store_errors import translate_errors',
      ...Array.from({ length: 9 }, (_, i) => `def test_case_${i}():`),
    ]),
    change(
      'src/app/stores/blob.py',
      'edited',
      ['from ._store_errors import translate_errors', '        with translate_errors():'],
      ['        try:'],
    ),
    change('src/app/exceptions.py', 'edited', [
      'class AccessDeniedError(AppError):',
      '    """Denied."""',
      'class ThrottledError(AppError):',
    ]),
    change('src/app/stores/_store_errors.py', 'new', [
      '"""Shared error translation for blob store calls."""',
      'def translate_errors():',
    ]),
    change('src/app/stores/async_blob.py', 'edited', [
      'from ._store_errors import translate_errors',
      '    with translate_errors():',
    ]),
    change('README.md', 'edited', ['More docs.', 'And more.'], ['Old docs.']),
  ];
}

test('one line per file, most important first; files with the same change share a line', () => {
  const { lines } = describeChanges(vecstore());
  expect(lines.map((l) => `${l.files.join(', ')} — ${l.text}`)).toEqual([
    '_store_errors.py — new: shared error translation for blob store calls',
    'exceptions.py — added 2 new exceptions (access denied, throttled)',
    'blob.py, async_blob.py — now use the new translate_errors',
    'test_store_errors.py — new: 9 tests for store errors',
    'README.md — changed 3 lines',
  ]);
});

test('what was built, in one sentence without paths', () => {
  expect(builtSentence(describeChanges(vecstore()).built)).toBe(
    'You added a new module (shared error translation for blob store calls), 2 new exception types and 9 tests.',
  );
});

test('added and removed functions in an edited file; a deleted file', () => {
  const { lines } = describeChanges([
    change(
      'src/cart.ts',
      'edited',
      ['export function addItem(item) {', 'export function clearCart() {'],
      ['export function emptyCart() {'],
    ),
    change('src/old.ts', 'deleted', [], ['export const x = 1']),
  ]);
  expect(lines.map((l) => `${l.files.join(', ')} — ${l.text}`)).toEqual([
    'cart.ts — added addItem, clearCart; removed emptyCart',
    'old.ts — deleted',
  ]);
});

test('at most 8 lines, then "+N more files"; duplicate file names show their folder', () => {
  const many = Array.from({ length: 11 }, (_, i) =>
    change(`pkg${i}/util.go`, 'edited', [`func Helper${i}() {`]),
  );
  const { lines, moreFiles } = describeChanges(many);
  expect(lines).toHaveLength(8);
  expect(moreFiles).toBe(3);
  expect(lines[0]?.files).toEqual(['pkg0/util.go']);
});

test('without new definitions or tests, the sentence says how many files changed and where', () => {
  const { built } = describeChanges([
    change('docs/a.md', 'edited', ['x']),
    change('docs/b.md', 'edited', ['x']),
    change('web/c.css', 'edited', ['x']),
    change('infra/d.yml', 'edited', ['x']),
    change('ci/e.yml', 'edited', ['x']),
  ]);
  expect(builtSentence(built)).toBe(
    'You changed 5 files, mostly in docs, web and infra (+1 more folder).',
  );
});

test('lockfiles are left out; new docs come after code; duplicate names show the folder that tells them apart', () => {
  const { lines } = describeChanges([
    change('docs/plans/2026-plan.md', 'new', [
      '# The M0 plan',
      ...Array.from({ length: 300 }, () => 'x'),
    ]),
    change(
      'Cargo.lock',
      'new',
      Array.from({ length: 900 }, () => 'x'),
    ),
    change('crates/kb/src/resolve.rs', 'new', [
      '//! Resolves knowledge-base names.',
      'pub fn resolve() {}',
    ]),
    change('crates/semantic/src/resolve.rs', 'new', [
      '//! Resolves names across files.',
      'pub fn resolve() {}',
    ]),
  ]);
  expect(lines.map((l) => `${l.files.join(', ')} — ${l.text}`)).toEqual([
    'kb/src/resolve.rs — new: resolves knowledge-base names',
    'semantic/src/resolve.rs — new: resolves names across files',
    '2026-plan.md — new: the M0 plan',
  ]);
});
