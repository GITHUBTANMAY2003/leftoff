// Event model from spec §1.5.

import { createHash } from 'node:crypto';
import { redact, redactDeep } from './redact.ts';

export type Source = 'git' | 'shell' | 'claude' | 'codex' | 'user';

export type EventKind =
  | 'session_start'
  | 'session_end'
  | 'checkpoint'
  | 'user_prompt'
  | 'agent_message'
  | 'file_edit'
  | 'command'
  | 'command_failed'
  | 'tool_error'
  | 'test_failed'
  | 'commit'
  | 'branch_switch'
  | 'note';

export interface WorkEvent {
  source: Source;
  kind: EventKind;
  projectRoot: string; // absolute path, see P5
  ts: string; // ISO 8601 UTC
  sessionRef: string | null; // agent session id, shell pid, etc.
  summary: string; // redacted, ≤ 300 chars
  data: Record<string, unknown>; // redacted, serialized ≤ 4096 bytes
  dedupeKey: string; // stable id; re-reading the same data never duplicates
}

const MAX_SUMMARY_CHARS = 300;
const MAX_DATA_BYTES = 4096;

export type EventInput = Omit<WorkEvent, 'summary' | 'data'> & {
  summary: string;
  data?: Record<string, unknown>;
};

// Stable id for an event: sha1 hex of the parts joined by NUL, so ("a","bc")
// and ("ab","c") differ.
export function dedupeKey(...parts: (string | number)[]): string {
  return createHash('sha1').update(parts.join('\u0000')).digest('hex');
}

// The only way collectors should build events: redacts first, then enforces
// the size limits from Global Constraints.
export function makeEvent(input: EventInput): WorkEvent {
  return {
    ...input,
    summary: truncate(redact(input.summary), MAX_SUMMARY_CHARS),
    data: shrink(redactDeep(input.data ?? {})),
  };
}

// Counts code points, so an emoji is never cut in half.
function truncate(text: string, max: number): string {
  const chars = Array.from(text);
  return chars.length <= max ? text : chars.slice(0, max - 1).join('') + '…';
}

const byteSize = (v: unknown) => Buffer.byteLength(JSON.stringify(v));

// Drops the largest top-level string fields until the JSON fits, marking the
// result { truncated: true }; if that is not enough, keeps only the marker.
// The command is cut to MAX_COMMAND_CHARS and dropped last: without it a
// failure can't be classified or resolved (found on real data, Task 14).
const MAX_COMMAND_CHARS = 1000;
function shrink(data: Record<string, unknown>): Record<string, unknown> {
  if (byteSize(data) <= MAX_DATA_BYTES) return data;
  const out: Record<string, unknown> = { ...data, truncated: true };
  if (typeof out.command === 'string') out.command = truncate(out.command, MAX_COMMAND_CHARS);
  while (byteSize(out) > MAX_DATA_BYTES) {
    let largest: string | null = null;
    for (const [k, v] of Object.entries(out)) {
      if (typeof v !== 'string' || k === 'command') continue;
      if (largest === null || byteSize(v) > byteSize(out[largest])) largest = k;
    }
    if (largest === null && typeof out.command === 'string') largest = 'command';
    if (largest === null) return { truncated: true };
    delete out[largest];
  }
  return out;
}

const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=("[^"]*"|'[^']*'|\S*)$/;
const REDIRECT = /^(\d|&)?>>?(&\d)?$/;
// `| tail -20`, `| head -n 5` (with arguments); `| cat`, `| less` (bare).
const isTrimPipe = (words: string[]) =>
  words[0] === 'tail' ||
  words[0] === 'head' ||
  (words.length === 1 && /^(cat|less)$/.test(words[0] ?? ''));

interface Token {
  text: string;
  start: number;
  end: number;
  op: boolean; // an unquoted operator: && || | ; & or an output redirection
}

// Splits a command line into words and operators, keeping quoted text inside
// its word, so `echo "a > b"` has no redirection.
function tokenize(s: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < s.length) {
    if (s[i] === ' ') {
      i++;
      continue;
    }
    const start = i;
    const op = /^(?:&&|\|\||(?:\d|&)?>>?(?:&\d)?|[|;&])/.exec(s.slice(i));
    if (op) {
      i += op[0].length;
      tokens.push({ text: op[0], start, end: i, op: true });
      continue;
    }
    let quote: string | null = null;
    while (i < s.length) {
      const c = s[i] as string;
      if (quote) {
        if (c === quote) quote = null;
        else if (c === '\\' && quote === '"') i++;
      } else if (c === '"' || c === "'") quote = c;
      else if (c === '\\') i++;
      else if (c === ' ' || '|;&>'.includes(c)) break;
      i++;
    }
    tokens.push({ text: s.slice(start, i), start, end: i, op: false });
  }
  return tokens;
}

// True when the command ends in `| tail …`, `| head …`, `| cat` or `| less`:
// its exit code is the pipe's, so a failing test run before it can exit 0.
export function endsWithTrimmingPipe(cmd: string): boolean {
  return trimmingPipeAt(tokenize(cmd.replace(/\s+/g, ' ').trim())) > 0;
}

// Index of a trailing trimming pipe's `|`, or -1.
function trimmingPipeAt(tokens: Token[]): number {
  let pipe = tokens.length - 1;
  while (pipe >= 0 && !tokens[pipe]?.op) pipe--;
  const after = tokens.slice(pipe + 1).map((t) => t.text);
  return pipe > 0 && tokens[pipe]?.text === '|' && isTrimPipe(after) ? pipe : -1;
}

// For comparing and showing commands (open problems, §1.7): collapse
// whitespace, then strip leading VAR=value assignments, leading `cd <dir> &&`
// steps, output redirections (2>&1, >/dev/null, >file.log, …) and trailing
// output-trimming pipes (| tail …, | head …, | cat, | less). Owner decision
// after Task 11. A command that is nothing but these is left as it is.
export function normalizeCommand(cmd: string): string {
  const s = cmd.replace(/\s+/g, ' ').trim();
  let tokens = tokenize(s).filter((t, i, all) => {
    if (t.op && REDIRECT.test(t.text)) return false;
    const prev = all[i - 1];
    // the file a redirection writes to
    return !(prev?.op && REDIRECT.test(prev.text) && !prev.text.includes('>&') && !t.op);
  });
  for (let changed = true; changed;) {
    changed = false;
    const first = tokens[0];
    // An env prefix (`FOO=1 npm test`), not a statement of its own (`R=/x; …`).
    if (first && !first.op && ASSIGNMENT.test(first.text) && tokens[1] && !tokens[1].op) {
      tokens = tokens.slice(1);
      changed = true;
    } else if (first?.text === 'cd') {
      const and = tokens.findIndex((t) => t.op);
      if (and > 0 && tokens[and]?.text === '&&' && and < tokens.length - 1) {
        tokens = tokens.slice(and + 1);
        changed = true;
      }
    }
    const pipe = trimmingPipeAt(tokens);
    if (pipe > 0) {
      tokens = tokens.slice(0, pipe);
      changed = true;
    }
  }
  if (tokens.length === 0) return s;
  // Rejoin with the original spacing between neighbours (`a&&b` stays as is).
  return tokens
    .map((t, i) => {
      const prev = tokens[i - 1];
      return prev === undefined || prev.end === t.start ? t.text : ` ${t.text}`;
    })
    .join('');
}

// Leading steps that only prepare the shell, and prefixes that only run the
// real program (found on the owner's real data after Task 13).
const SETUP_STEPS = new Set(['cd', 'pushd', 'source', '.', 'export', 'set']);
const RUNNERS = [
  ['npx'],
  ['bunx'],
  ['uvx'],
  ['uv', 'run'],
  ['pnpm', 'exec'],
  ['pnpm', 'dlx'],
  ['yarn', 'dlx'],
  ['poetry', 'run'],
  ['pipx', 'run'],
  ['bundle', 'exec'],
];

// The program and its subcommand, for resolving failures (owner decision after
// Task 13). Leading setup steps (`cd`, `source`, `export`, `set`) and runner
// prefixes (`npx`, `uv run`, `pnpm exec`, … with their flags) are skipped. Then
// the first words up to a flag or `--`, at most three; after the second word a
// path or file name ends it; a program followed by a flag keeps that flag
// (`node --test`). `npx vitest run tests/a.test.ts` → `vitest run`. A command
// that still has several steps is its own key: it only matches itself.
export function commandKey(cmd: string): string {
  const words = programWords(cmd);
  if (words === null) return normalizeCommand(cmd);
  const [program = '', ...rest] = words;
  const key = [program];
  for (const w of rest) {
    if (key.length === 3 || w === '--') break;
    if (w.startsWith('-')) {
      if (key.length === 1) key.push(w);
      break;
    }
    if (key.length >= 2 && isFileArgument(w)) break;
    key.push(w);
  }
  return key.join(' ');
}

const isFileArgument = (w: string) => w.includes('/') || /\.\w+$/.test(w);

// The words of the one real step of a command (setup steps and runner prefixes
// skipped), or null when it has several steps or lines.
function programWords(cmd: string): string[] | null {
  // A single pipeline into a text filter is the command before the filter.
  const base = endsWithFilter(cmd) ? withoutFilters(cmd) : cmd;
  const steps: string[][] = [[]];
  for (const t of tokenize(normalizeCommand(base))) {
    if (t.op) steps.push([]);
    else steps.at(-1)?.push(t.text);
  }
  while (steps.length > 1 && SETUP_STEPS.has(steps[0]?.[0] ?? '')) steps.shift();
  // Lines of a multi-line command are steps too (normalizeCommand joins them).
  if (steps.length !== 1 || base.trim().includes('\n')) return null;
  let words = steps[0] as string[];
  const runner = RUNNERS.find((r) => r.every((w, i) => words[i] === w));
  if (runner) {
    words = words.slice(runner.length);
    while (words[0]?.startsWith('-')) words = words.slice(1);
  }
  return words;
}

// The file and path arguments of a command, sorted (owner decision after Task
// 13): a success resolves a failure only with the same files, or with none (a
// whole-project run).
export function commandFiles(cmd: string): string[] {
  const words = programWords(cmd) ?? [];
  return [...new Set(words.slice(1).filter((w) => !w.startsWith('-') && isFileArgument(w)))].sort();
}

// Text filters whose exit code says nothing about the command piped into them
// (`npx vitest run | grep FAIL` exits 1 when nothing matched). Owner decision
// after Task 13.
const FILTERS = new Set([
  'grep',
  'rg',
  'head',
  'tail',
  'sed',
  'awk',
  'wc',
  'jq',
  'sort',
  'uniq',
  'cut',
  'cat',
  'less',
]);

// Index of the `|` before a trailing text filter, or -1.
function filterPipeAt(tokens: Token[]): number {
  let pipe = tokens.length - 1;
  while (pipe >= 0 && !tokens[pipe]?.op) pipe--;
  const program = tokens[pipe + 1]?.text ?? '';
  return pipe > 0 && tokens[pipe]?.text === '|' && FILTERS.has(program) ? pipe : -1;
}

// True when the command is one pipeline (after leading setup steps such as
// `cd x &&`) whose last program is a text filter. In a chain (`a && b | grep`)
// the exit code may be an earlier step's, so it is not decided here.
export function endsWithFilter(cmd: string): boolean {
  let tokens = tokenize(cmd.replace(/\s+/g, ' ').trim());
  for (let and = tokens.findIndex((t) => t.op); ; and = tokens.findIndex((t) => t.op)) {
    if (!(and > 0 && tokens[and]?.text === '&&' && SETUP_STEPS.has(tokens[0]?.text ?? ''))) break;
    tokens = tokens.slice(and + 1);
  }
  if (tokens.some((t) => t.op && t.text !== '|' && !REDIRECT.test(t.text))) return false;
  return filterPipeAt(tokens) > 0;
}

// The command without its trailing text filters: `npx vitest run | grep FAIL`
// → `npx vitest run`.
export function withoutFilters(cmd: string): string {
  const s = cmd.replace(/\s+/g, ' ').trim();
  let tokens = tokenize(s);
  for (let pipe = filterPipeAt(tokens); pipe > 0; pipe = filterPipeAt(tokens)) {
    tokens = tokens.slice(0, pipe);
  }
  const last = tokens.at(-1);
  return last ? s.slice(0, last.end) : s;
}

// The steps of a `&&` / `;` chain, split outside quotes: `cd x && ls; cat a`
// → ['cd x', 'ls', 'cat a']. A command without a chain is one step.
export function chainSteps(cmd: string): string[] {
  const s = cmd.replace(/\s+/g, ' ').trim();
  const steps: string[] = [];
  let from = 0;
  for (const t of tokenize(s)) {
    if (!t.op || (t.text !== '&&' && t.text !== ';')) continue;
    steps.push(s.slice(from, t.start).trim());
    from = t.end;
  }
  steps.push(s.slice(from).trim());
  return steps.filter((step) => step !== '');
}

// The first program of a pipeline (after cd steps and env prefixes), or null
// when the command line has no unquoted `|`.
export function pipelineHead(cmd: string): string | null {
  const s = cmd.replace(/\s+/g, ' ').trim();
  if (!tokenize(s).some((t) => t.op && t.text === '|')) return null;
  let tokens = tokenize(s);
  for (let changed = true; changed;) {
    changed = false;
    const first = tokens[0];
    if (first && !first.op && ASSIGNMENT.test(first.text) && tokens[1] && !tokens[1].op) {
      tokens = tokens.slice(1);
      changed = true;
    } else if (first?.text === 'cd') {
      const and = tokens.findIndex((t) => t.op);
      if (and > 0 && tokens[and]?.text === '&&') {
        tokens = tokens.slice(and + 1);
        changed = true;
      }
    }
  }
  const head = tokens[0];
  return head && !head.op ? head.text : null;
}
