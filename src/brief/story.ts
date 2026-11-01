import { basename } from 'node:path';
import {
  definitionsIn,
  docLine,
  isSourceFile,
  isTestFile,
  testsAdded,
  type Definition,
  type FileChange,
} from './changes.ts';
import { folderName, folderOf } from './work.ts';

// "Files you changed" and "what was built", from the work window's diff (owner
// decision after Task 15e: no LLM, the developer's own words). One line per
// file, most important first: new modules, files with new definitions, files
// that now use something new, new tests, other edits, deletions.

export interface FileLine {
  files: string[]; // display names: the file name, with its folder when two share a name
  text: string; // "new: shared error translation for …", "added 2 new exceptions (…)"
}
export interface Built {
  modules: string[]; // a new module's own description, else its name
  exceptions: number;
  classes: number;
  functions: number;
  tests: number;
  files: number;
  folders: string[]; // most files first
}

const MAX_LINES = 8;
const MAX_NAMES = 3;
const MAX_FOLDERS = 3;
const ERROR_SUFFIX = /(Error|Exception|Exc|Fault|Failure)$/;

const joinAnd = (items: string[]) =>
  items.length <= 1 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`;
const names = (defs: Definition[]) => {
  const list = defs.map((d) => d.name);
  return list.length <= MAX_NAMES
    ? list.join(', ')
    : `${list.slice(0, MAX_NAMES).join(', ')} and ${list.length - MAX_NAMES} more`;
};
// AccessDeniedError → "access denied"
const humanize = (name: string) =>
  name
    .replace(ERROR_SUFFIX, '')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/_/g, ' ')
    .toLowerCase()
    .trim() || name;
const lowerFirst = (text: string) =>
  /^[A-Z][a-z]/.test(text) ? text[0]?.toLowerCase() + text.slice(1) : text;
// tests/test_store_errors.py → "store errors"
const testTopic = (path: string) =>
  basename(path)
    .replace(/\.[^.]+$/, '')
    .replace(/^test_|_test$|[._-](test|spec)$|Tests?$/gi, '')
    .replace(/[_-]+/g, ' ')
    .trim();

interface Described {
  path: string;
  text: string;
  rank: number;
  size: number;
}

function newDefinitions(c: FileChange): Definition[] {
  const before = new Set(definitionsIn(c.path, c.removed).map((d) => d.name));
  return definitionsIn(c.path, c.added).filter((d) => !before.has(d.name));
}

function describe(c: FileChange, newSymbols: Map<string, string>): Described {
  const size = c.added.length + c.removed.length;
  if (c.status === 'deleted') return { path: c.path, text: 'deleted', rank: 6, size };
  const tests = testsAdded(c.path, c.added);
  if (c.status === 'new' && isTestFile(c.path)) {
    const topic = testTopic(c.path);
    const text =
      tests > 0
        ? `new: ${tests} ${tests === 1 ? 'test' : 'tests'}${topic ? ` for ${topic}` : ''}`
        : 'new: tests';
    return { path: c.path, text, rank: 3, size };
  }
  const defs = newDefinitions(c);
  if (c.status === 'new') {
    const doc = docLine(c.path, c.added);
    const text = doc
      ? `new: ${lowerFirst(doc)}`
      : defs.length > 0
        ? `new: adds ${names(defs)}`
        : 'new';
    // new code first; new documents and other files after the code changes
    return { path: c.path, text, rank: isSourceFile(c.path) ? 0 : 4.5, size };
  }
  const parts: string[] = [];
  const exceptions = defs.filter((d) => d.kind === 'exception');
  const others = defs.filter((d) => d.kind !== 'exception');
  if (exceptions.length > 0) {
    const list = exceptions.map((d) => humanize(d.name)).join(', ');
    parts.push(
      exceptions.length === 1
        ? `added a new exception (${list})`
        : `added ${exceptions.length} new exceptions (${list})`,
    );
  }
  if (others.length > 0) parts.push(`added ${names(others)}`);
  if (tests > 0) parts.push(`${tests} new ${tests === 1 ? 'test' : 'tests'}`);
  const after = new Set(definitionsIn(c.path, c.added).map((d) => d.name));
  const removed = definitionsIn(c.path, c.removed).filter((d) => !after.has(d.name));
  if (removed.length > 0) parts.push(`removed ${names(removed)}`);
  if (parts.length > 0)
    return {
      path: c.path,
      text: parts.join('; '),
      rank: tests > 0 && defs.length === 0 ? 4 : 1,
      size,
    };
  // An edit that uses something new from another file.
  const used = [...newSymbols].find(
    ([name, file]) => file !== c.path && c.added.some((l) => new RegExp(`\\b${name}\\b`).test(l)),
  );
  if (used) return { path: c.path, text: `now uses the new ${used[0]}`, rank: 2, size };
  return {
    path: c.path,
    text: size <= 2 ? 'small change' : `changed ${size} lines`,
    rank: 5,
    size,
  };
}

// Generated lockfiles say nothing about the work.
const LOCKFILES = new Set([
  'Cargo.lock',
  'package-lock.json',
  'npm-shrinkwrap.json',
  'yarn.lock',
  'pnpm-lock.yaml',
  'bun.lockb',
  'poetry.lock',
  'uv.lock',
  'Pipfile.lock',
  'Gemfile.lock',
  'composer.lock',
  'go.sum',
  'mix.lock',
]);

// The shortest end of each path that tells files with the same name apart.
function displayNames(paths: string[]): Map<string, string> {
  const shown = new Map<string, string>();
  for (const path of paths) {
    const parts = path.split('/');
    for (let n = 1; n <= parts.length; n++) {
      const tail = parts.slice(-n).join('/');
      const unique = paths.every(
        (other) => other === path || (other !== tail && !other.endsWith(`/${tail}`)),
      );
      if (unique || n === parts.length) {
        shown.set(path, tail);
        break;
      }
    }
  }
  return shown;
}

export function describeChanges(all: FileChange[]): {
  lines: FileLine[];
  moreFiles: number;
  built: Built;
} {
  const changes = all.filter((c) => !LOCKFILES.has(basename(c.path)));
  const newSymbols = new Map<string, string>();
  for (const c of changes) {
    if (c.status === 'deleted') continue;
    for (const d of c.status === 'new' ? definitionsIn(c.path, c.added) : newDefinitions(c)) {
      if (!newSymbols.has(d.name)) newSymbols.set(d.name, c.path);
    }
  }
  const described = changes
    .map((c, i) => ({ ...describe(c, newSymbols), order: i }))
    .sort((a, b) => a.rank - b.rank || b.size - a.size || a.order - b.order);

  // Display names: the file name, with as much of its path as tells it apart.
  const unique = displayNames(described.map((d) => d.path));
  const shown = (path: string) => unique.get(path) ?? basename(path);

  // Files with the same change share a line ("now use the new …").
  const lines: FileLine[] = [];
  for (const d of described) {
    const same = lines.find((l) => l.text === d.text && d.text.startsWith('now uses'));
    if (same) same.files.push(shown(d.path));
    else lines.push({ files: [shown(d.path)], text: d.text });
  }
  for (const l of lines) if (l.files.length > 1) l.text = l.text.replace(/^now uses/, 'now use');

  const sourceNew = changes.filter(
    (c) =>
      c.status === 'new' &&
      isSourceFile(c.path) &&
      !isTestFile(c.path) &&
      definitionsIn(c.path, c.added).length + (docLine(c.path, c.added) ? 1 : 0) > 0,
  );
  const defs = changes
    .filter((c) => c.status !== 'deleted' && !sourceNew.includes(c))
    .flatMap(newDefinitions);
  const folderCounts = new Map<string, number>();
  for (const c of changes)
    folderCounts.set(folderOf(c.path), (folderCounts.get(folderOf(c.path)) ?? 0) + 1);
  const built: Built = {
    modules: sourceNew.map((c) => docLine(c.path, c.added) ?? basename(c.path)),
    exceptions: [...sourceNew.flatMap((c) => definitionsIn(c.path, c.added)), ...defs].filter(
      (d) => d.kind === 'exception',
    ).length,
    classes: defs.filter((d) => d.kind === 'class').length,
    functions: defs.filter((d) => d.kind === 'function').length,
    tests: changes.reduce(
      (n, c) => n + (c.status === 'deleted' ? 0 : testsAdded(c.path, c.added)),
      0,
    ),
    files: changes.length,
    folders: [...folderCounts].sort((a, b) => b[1] - a[1]).map(([f]) => f),
  };
  return {
    lines: lines.slice(0, MAX_LINES),
    moreFiles: Math.max(
      0,
      described.length - lines.slice(0, MAX_LINES).reduce((n, l) => n + l.files.length, 0),
    ),
    built,
  };
}

// "You added a new module (…), 2 new exception types and 9 tests." — or, with
// nothing new to name, how many files changed and where.
export function builtSentence(b: Built): string | null {
  const parts: string[] = [];
  if (b.modules.length === 1) parts.push(`a new module (${lowerFirst(b.modules[0] as string)})`);
  else if (b.modules.length > 1) parts.push(`${b.modules.length} new modules`);
  if (b.exceptions > 0)
    parts.push(`${b.exceptions} new exception ${b.exceptions === 1 ? 'type' : 'types'}`);
  if (b.classes > 0) parts.push(`${b.classes} new ${b.classes === 1 ? 'class' : 'classes'}`);
  if (b.functions > 0 && parts.length === 0)
    parts.push(`${b.functions} new ${b.functions === 1 ? 'function' : 'functions'}`);
  if (b.tests > 0) parts.push(`${b.tests} ${b.tests === 1 ? 'test' : 'tests'}`);
  if (parts.length > 0) return `You added ${joinAnd(parts)}.`;
  if (b.files === 0) return null;
  const shownFolders = b.folders.filter((f) => f !== '.').slice(0, MAX_FOLDERS);
  const more = b.folders.filter((f) => f !== '.').length - shownFolders.length;
  const where =
    shownFolders.length > 0
      ? `, mostly in ${joinAnd(shownFolders.map(folderName))}${more > 0 ? ` (+${more} more ${more === 1 ? 'folder' : 'folders'})` : ''}`
      : '';
  return `You changed ${b.files} ${b.files === 1 ? 'file' : 'files'}${where}.`;
}
