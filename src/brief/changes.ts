import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { extname, join } from 'node:path';

// What changed in the work window, read from git (owner decision after Task
// 15e: no LLM in the main experience; the developer's own words — names of
// new functions, classes and tests, a new file's docstring). One pattern
// table per language. To support a language, add rows here with a case in
// tests/brief/changes.test.ts.

export interface FileChange {
  path: string;
  status: 'new' | 'edited' | 'deleted';
  added: string[];
  removed: string[];
}

export interface Definition {
  name: string;
  kind: 'function' | 'class' | 'exception' | 'type';
}

// ---- the diff ----

export function parseUnifiedDiff(diff: string): FileChange[] {
  const files: FileChange[] = [];
  let current: FileChange | null = null;
  for (const line of diff.split('\n')) {
    const header = /^diff --git a\/(.+) b\/(.+)$/.exec(line);
    if (header) {
      current = { path: header[2] as string, status: 'edited', added: [], removed: [] };
      files.push(current);
      continue;
    }
    if (current === null) continue;
    if (line.startsWith('new file mode')) current.status = 'new';
    else if (line.startsWith('deleted file mode')) current.status = 'deleted';
    else if (line.startsWith('rename to ')) current.path = line.slice('rename to '.length);
    else if (line.startsWith('+++ ') || line.startsWith('--- ') || line.startsWith('@@')) continue;
    else if (line.startsWith('+')) current.added.push(line.slice(1));
    else if (line.startsWith('-')) current.removed.push(line.slice(1));
  }
  return files;
}

const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
const MAX_DIFF_BYTES = 8 * 1024 * 1024;
const MAX_UNTRACKED_BYTES = 256 * 1024;

const git = (root: string, args: string[]) =>
  execFileSync('git', ['-C', root, ...args], {
    encoding: 'utf8',
    timeout: 3000,
    maxBuffer: MAX_DIFF_BYTES,
    stdio: ['ignore', 'pipe', 'ignore'],
    env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
  });

function known(root: string, rev: string): boolean {
  try {
    git(root, ['rev-parse', '--verify', '-q', rev]);
    return true;
  } catch {
    return false;
  }
}

// The work window's changes: from just before its first commit to the
// working tree (committed and uncommitted), plus untracked files. Limited to
// `files` when given (the window's own commits' files and the uncommitted
// ones, so a teammate's commit pulled in between doesn't count). [] when git
// can't tell.
export function readWorkChanges(
  root: string,
  firstCommit: string | null,
  files: string[] | null,
): FileChange[] {
  try {
    let base = 'HEAD';
    if (firstCommit !== null && known(root, `${firstCommit}^{commit}`)) {
      // just before the window's first commit; the repo's very first commit
      // has no parent, so the diff starts from nothing
      base = known(root, `${firstCommit}^`) ? `${firstCommit}^` : EMPTY_TREE;
    }
    const changes = parseUnifiedDiff(
      git(root, ['diff', '--no-color', '--no-ext-diff', '-U0', '-M', base, '--', ...(files ?? [])]),
    );
    const untracked = git(root, ['ls-files', '--others', '--exclude-standard'])
      .split('\n')
      // git status lists an untracked folder as `dir/`: its files count too
      .filter(
        (f) =>
          f !== '' &&
          (files === null || files.some((g) => g === f || (g.endsWith('/') && f.startsWith(g)))),
      );
    for (const path of untracked) {
      const full = join(root, path);
      if (!existsSync(full) || statSync(full).size > MAX_UNTRACKED_BYTES) continue;
      const added = readFileSync(full, 'utf8').split('\n');
      changes.push({ path, status: 'new', added, removed: [] });
    }
    return changes;
  } catch {
    return [];
  }
}

// ---- definitions, per language ----

type Language = 'python' | 'js' | 'go' | 'rust' | 'jvm' | 'c' | 'shell';
const LANGUAGES: Record<string, Language> = {
  '.py': 'python',
  '.js': 'js',
  '.jsx': 'js',
  '.mjs': 'js',
  '.cjs': 'js',
  '.ts': 'js',
  '.tsx': 'js',
  '.mts': 'js',
  '.go': 'go',
  '.rs': 'rust',
  '.java': 'jvm',
  '.kt': 'jvm',
  '.kts': 'jvm',
  '.cs': 'jvm',
  '.scala': 'jvm',
  '.c': 'c',
  '.h': 'c',
  '.cc': 'c',
  '.cpp': 'c',
  '.cxx': 'c',
  '.hpp': 'c',
  '.sh': 'shell',
  '.bash': 'shell',
  '.zsh': 'shell',
};
const languageOf = (path: string): Language | null =>
  LANGUAGES[extname(path).toLowerCase()] ?? null;

const ERRORISH = /(Error|Exception|Exc|Fault|Failure)$/;
const KEYWORDS = new Set([
  'if',
  'for',
  'while',
  'switch',
  'return',
  'catch',
  'else',
  'do',
  'new',
  'sizeof',
]);

type Row = {
  pattern: RegExp;
  kind: (m: RegExpExecArray) => Definition['kind'] | null;
  name?: number;
};
const classKind = (name: string, base = '') =>
  ERRORISH.test(name) || /\b(Error|Exception|BaseException)\b/.test(base) ? 'exception' : 'class';

const TABLE: Record<Language, Row[]> = {
  python: [
    { pattern: /^\s*(?:async\s+)?def\s+(\w+)/, kind: () => 'function' },
    {
      pattern: /^\s*class\s+(\w+)\s*(?:\(([^)]*)\))?\s*:/,
      kind: (m) => classKind(m[1] as string, m[2]),
    },
  ],
  js: [
    {
      pattern:
        /^\s*(?:export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+(\w+)(?:\s+extends\s+([\w.]+))?/,
      kind: (m) => classKind(m[1] as string, m[2]),
    },
    {
      pattern: /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*(\w+)\s*[(<]/,
      kind: () => 'function',
    },
    {
      pattern:
        /^\s*(?:export\s+)?(?:const|let)\s+(\w+)\s*(?::[^=]+)?=\s*(?:async\s*)?(?:\([^)]*\)|\w+)\s*(?::[^=]+)?=>/,
      kind: () => 'function',
    },
  ],
  go: [
    { pattern: /^func\s+(?:\([^)]*\)\s*)?(\w+)\s*[([]/, kind: () => 'function' },
    {
      pattern: /^type\s+(\w+)\s+(?:struct|interface)\b/,
      kind: (m) => (ERRORISH.test(m[1] as string) ? 'exception' : 'type'),
    },
  ],
  rust: [
    {
      pattern: /^\s*(?:pub(?:\([^)]*\))?\s+)?(?:const\s+)?(?:async\s+)?(?:unsafe\s+)?fn\s+(\w+)/,
      kind: () => 'function',
    },
    {
      pattern: /^\s*(?:pub(?:\([^)]*\))?\s+)?(?:struct|enum|trait|union)\s+(\w+)/,
      kind: (m) => (ERRORISH.test(m[1] as string) ? 'exception' : 'type'),
    },
  ],
  jvm: [
    {
      pattern:
        /^\s*(?:(?:public|private|protected|internal|static|final|abstract|sealed|open|data|partial)\s+)*(?:class|interface|enum|record|object)\s+(\w+)(?:[^{]*?\b(?:extends|:)\s*([\w.]+))?/,
      kind: (m) => classKind(m[1] as string, m[2]),
    },
    {
      pattern:
        /^\s*(?:(?:override|private|public|protected|internal|suspend|open|inline)\s+)*fun\s+(?:<[^>]+>\s*)?(?:[\w.]+\.)?(\w+)\s*\(/,
      kind: () => 'function',
    },
    {
      pattern:
        /^\s*(?:(?:public|private|protected|internal|static|final|override|virtual|abstract|async|synchronized)\s+)+[\w<>[\],.?\s]*?\b(\w+)\s*\([^;]*$/,
      kind: (m) => (KEYWORDS.has(m[1] as string) ? null : 'function'),
    },
  ],
  c: [
    {
      pattern: /^\s*(?:template\s*<[^>]*>\s*)?class\s+(\w+)\s*(?:[:{]|$)/,
      kind: (m) => classKind(m[1] as string),
    },
    { pattern: /^\s*(?:typedef\s+)?struct\s+(\w+)\s*(?:[:{]|$)/, kind: () => 'type' },
    {
      pattern: /^(?:[\w*&:<>]+\s+)+\**([\w:~]+)\s*\([^;]*\)\s*(?:const\s*)?\{?\s*$/,
      kind: (m) => (KEYWORDS.has(m[1] as string) ? null : 'function'),
    },
  ],
  shell: [
    { pattern: /^\s*function\s+([\w-]+)\s*(?:\(\))?\s*\{?\s*$/, kind: () => 'function' },
    { pattern: /^\s*([\w-]+)\s*\(\)\s*\{?\s*$/, kind: () => 'function' },
  ],
};

export function definitionsIn(path: string, lines: string[]): Definition[] {
  const language = languageOf(path);
  if (language === null) return [];
  const found: Definition[] = [];
  for (const line of lines) {
    for (const row of TABLE[language]) {
      const m = row.pattern.exec(line);
      if (!m) continue;
      const kind = row.kind(m);
      if (kind !== null) found.push({ name: m[1] as string, kind });
      break;
    }
  }
  return found;
}

// ---- tests ----

const TEST_PATTERNS: Record<Language, RegExp> = {
  python: /^\s*(?:async\s+)?def\s+test_?\w*\s*\(/,
  js: /^\s*(?:it|test)(?:\.(?:only|skip|each\([^)]*\)))?\s*\(\s*['"`]/,
  go: /^func\s+(?:Test|Benchmark|Fuzz)\w*\s*\(/,
  rust: /^\s*#\[(?:[\w:]+::)?test\]/,
  jvm: /^\s*(?:@(?:Test|ParameterizedTest)\b|\[(?:Test|Fact|Theory|TestMethod)\b)/,
  c: /^\s*TEST(?:_F|_P)?\s*\(/,
  shell: /^\s*@test\s+['"]/,
};

export function testsAdded(path: string, lines: string[]): number {
  const language = languageOf(path);
  return language === null ? 0 : lines.filter((l) => TEST_PATTERNS[language].test(l)).length;
}

export const isTestFile = (path: string) =>
  /(^|\/)(tests?|__tests__|spec)\//.test(path) ||
  /(^|\/)test_[^/]+$|_test\.\w+$|\.(test|spec)\.\w+$|Tests?\.\w+$/.test(path);

// ---- a new file's own description ----

const BOILERPLATE = /copyright|license|spdx|@generated|eslint|prettier|-\*-|^!\//i;
const firstSentence = (text: string) =>
  (text.trim().split(/(?<=[.!?])\s/)[0] ?? '').replace(/[.!]+$/, '').trim();

// Markdown kept as words: `code` and [links](…) and [`refs`] become plain text.
const plainMarkdown = (text: string) =>
  text
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[`?([^\]`]*)`?\]/g, '$1')
    .replace(/`/g, '')
    .replace(/\*\*|__/g, '')
    .trim();

// The text of one comment line, '' for an opening or empty comment line, or
// null when the line is code.
function commentText(language: Language | null, line: string): string | null {
  if (language === 'python' || language === 'shell') {
    return line.startsWith('#') ? line.replace(/^#+\s*/, '') : null;
  }
  if (line === '/**' || line === '/*' || line === '*/') return '';
  if (/^(\/\/[/!]?|\/\*+|\*)/.test(line)) {
    const text = line
      .replace(/^(\/\/[/!]?|\/\*+|\*+)\s*/, '')
      .replace(/\*\/$/, '')
      .trim();
    return language === 'go' ? text.replace(/^Package\s+\w+\s+/, '') : text;
  }
  return null;
}

// A new file's own description: its first heading (Markdown), or the first
// sentence of its module docstring or header comment, read across lines.
export function docLine(path: string, lines: string[]): string | null {
  if (/\.(md|markdown|rst|txt)$/i.test(path)) {
    const heading = lines.find((l) => /^#{1,6}\s+\S/.test(l.trim()));
    return heading ? plainMarkdown(heading.trim().replace(/^#+\s*/, '')) || null : null;
  }
  const language = languageOf(path);
  const parts: string[] = [];
  let docstring: string | null = null; // the quote a multi-line Python docstring ends with
  for (const raw of lines.slice(0, 40)) {
    const line = raw.trim();
    if (docstring !== null) {
      const end = line.indexOf(docstring);
      const text = end >= 0 ? line.slice(0, end) : line;
      if (text !== '') parts.push(text);
      if (end >= 0 || /[.!?]$/.test(text)) break;
      continue;
    }
    if (parts.length === 0 && (line === '' || line.startsWith('#!') || BOILERPLATE.test(line)))
      continue;
    const doc = language === 'python' ? /^[rbu]?("""|''')(.*)$/.exec(line) : null;
    if (doc) {
      const quote = doc[1] as string;
      const rest = doc[2] as string;
      const end = rest.indexOf(quote);
      if (end >= 0) {
        parts.push(rest.slice(0, end));
        break;
      }
      if (rest !== '') parts.push(rest);
      docstring = quote;
      continue;
    }
    const text = commentText(language, line);
    if (text === null) break; // code: the description has ended (or never began)
    if (text === '') {
      if (parts.length > 0) break;
      continue;
    }
    if (parts.length === 0 && BOILERPLATE.test(text)) continue;
    parts.push(text);
    if (/[.!?]$/.test(text)) break;
  }
  const sentence = firstSentence(plainMarkdown(parts.join(' ')));
  return sentence === '' ? null : sentence;
}

export const isSourceFile = (path: string) => languageOf(path) !== null;
