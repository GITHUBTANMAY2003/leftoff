import { describe, expect, test } from 'vitest';
import { definitionsIn, docLine, parseUnifiedDiff, testsAdded } from '../../src/brief/changes.ts';

// What changed in the work window, from the diff (owner decision: no LLM, the
// developer's own words). One pattern table per language.

test('parseUnifiedDiff: new, edited and deleted files with their added and removed lines', () => {
  const diff = [
    'diff --git a/src/app/errors.py b/src/app/errors.py',
    'new file mode 100644',
    '--- /dev/null',
    '+++ b/src/app/errors.py',
    '@@ -0,0 +1,2 @@',
    '+"""Shared error translation."""',
    '+def translate(): pass',
    'diff --git a/src/app/store.py b/src/app/store.py',
    '--- a/src/app/store.py',
    '+++ b/src/app/store.py',
    '@@ -1,2 +1,2 @@',
    '-old = 1',
    '+from .errors import translate',
    'diff --git a/old.txt b/old.txt',
    'deleted file mode 100644',
    '--- a/old.txt',
    '+++ /dev/null',
    '@@ -1 +0,0 @@',
    '-gone',
  ].join('\n');
  expect(parseUnifiedDiff(diff)).toEqual([
    {
      path: 'src/app/errors.py',
      status: 'new',
      added: ['"""Shared error translation."""', 'def translate(): pass'],
      removed: [],
    },
    {
      path: 'src/app/store.py',
      status: 'edited',
      added: ['from .errors import translate'],
      removed: ['old = 1'],
    },
    { path: 'old.txt', status: 'deleted', added: [], removed: ['gone'] },
  ]);
});

describe('definitions per language', () => {
  test.each([
    [
      'a.py',
      [
        'def map_error(code):',
        '    async def fetch(self):',
        'class NotFoundError(DynavecError):',
        'class Store:',
      ],
      [
        ['map_error', 'function'],
        ['fetch', 'function'],
        ['NotFoundError', 'exception'],
        ['Store', 'class'],
      ],
    ],
    [
      'a.ts',
      [
        'export function mapError(code: string) {',
        'export default class Cart {',
        'export const total = (x) => x',
        'async function load() {',
        'export class TimeoutError extends Error {',
      ],
      [
        ['mapError', 'function'],
        ['Cart', 'class'],
        ['total', 'function'],
        ['load', 'function'],
        ['TimeoutError', 'exception'],
      ],
    ],
    [
      'a.go',
      [
        'func MapError(code string) error {',
        'func (s *Store) Put(v Vec) error {',
        'type Store struct {',
        'type Mapper interface {',
      ],
      [
        ['MapError', 'function'],
        ['Put', 'function'],
        ['Store', 'type'],
        ['Mapper', 'type'],
      ],
    ],
    [
      'a.rs',
      [
        'pub fn map_error(code: &str) -> Error {',
        '    fn helper() {}',
        'pub struct Store {',
        'pub enum ParseError {',
        'pub trait Mapper {',
        'impl Store {',
      ],
      [
        ['map_error', 'function'],
        ['helper', 'function'],
        ['Store', 'type'],
        ['ParseError', 'exception'],
        ['Mapper', 'type'],
      ],
    ],
    [
      'A.java',
      [
        'public class OrderService {',
        '    public Order place(Cart cart) {',
        'public class OrderMissingException extends RuntimeException {',
      ],
      [
        ['OrderService', 'class'],
        ['place', 'function'],
        ['OrderMissingException', 'exception'],
      ],
    ],
    [
      'A.kt',
      ['class Cart(val items: List<Item>) {', '    fun total(): Int {'],
      [
        ['Cart', 'class'],
        ['total', 'function'],
      ],
    ],
    [
      'A.cs',
      ['public sealed class Cart {', '    public int Total() {'],
      [
        ['Cart', 'class'],
        ['Total', 'function'],
      ],
    ],
    [
      'a.cpp',
      ['int parse_header(const char *buf) {', 'class Parser {', 'struct Token {'],
      [
        ['parse_header', 'function'],
        ['Parser', 'class'],
        ['Token', 'type'],
      ],
    ],
    [
      'deploy.sh',
      ['deploy() {', 'function rollback {'],
      [
        ['deploy', 'function'],
        ['rollback', 'function'],
      ],
    ],
  ])('%s', (path, lines, expected) => {
    expect(definitionsIn(path, lines).map((d) => [d.name, d.kind])).toEqual(expected);
  });

  test('calls and control flow are not definitions', () => {
    expect(definitionsIn('a.ts', ['if (x) {', 'return foo(bar);', 'for (const x of y) {'])).toEqual(
      [],
    );
    expect(definitionsIn('a.c', ['if (x) {', 'return parse(buf);', 'while (n--) {'])).toEqual([]);
  });
});

test.each([
  [
    'tests/test_errors.py',
    ['def test_maps_not_found():', '    def test_keeps_retryable(self):', 'def helper():'],
    2,
  ],
  [
    'src/cart.test.ts',
    ["it('adds an item', () => {", "  test('removes it', async () => {", 'describe("x", () => {'],
    2,
  ],
  ['store_test.go', ['func TestPut(t *testing.T) {', 'func helper() {'], 1],
  ['lib.rs', ['#[test]', 'fn parses() {}', '#[tokio::test]', 'async fn fetches() {}'], 2],
  ['CartTest.java', ['@Test', 'void addsItem() {}'], 1],
])('testsAdded(%s) → %i', (path, lines, n) => {
  expect(testsAdded(path, lines)).toBe(n);
});

test.each([
  [
    'a.py',
    ['"""Shared error translation for S3 Vectors AWS calls."""', 'import x'],
    'Shared error translation for S3 Vectors AWS calls',
  ],
  [
    'a.py',
    ['# Maps client errors to our exceptions.', 'import x'],
    'Maps client errors to our exceptions',
  ],
  [
    'a.ts',
    ['/**', ' * Retries a request with backoff.', ' */', 'export function retry() {}'],
    'Retries a request with backoff',
  ],
  [
    'a.go',
    ['// Package mapper turns AWS errors into ours.', 'package mapper'],
    'turns AWS errors into ours',
  ],
  ['a.rs', ['//! Parses config files.', 'use x;'], 'Parses config files'],
  ['a.py', ['import x'], null],
])('docLine(%s)', (path, lines, expected) => {
  expect(docLine(path, lines)).toBe(expected);
});

// ---- from the owner's real Rust project ----

test('a doc comment over several lines is read to the end of its first sentence; markdown is dropped', () => {
  expect(
    docLine('src/resolve.rs', [
      '//! Name resolution across files, and the values that names and expressions',
      '//! evaluate to. Used by every rule.',
      'use x;',
    ]),
  ).toBe('Name resolution across files, and the values that names and expressions evaluate to');
  expect(docLine('mod.rs', ['//! Lowering of a tree to [`FileSemantics`].'])).toBe(
    'Lowering of a tree to FileSemantics',
  );
});

test('a Markdown file is described by its first heading', () => {
  expect(docLine('docs/plan.md', ['# Agent linter design', '', 'Body.'])).toBe(
    'Agent linter design',
  );
});
