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
function shrink(data: Record<string, unknown>): Record<string, unknown> {
  if (byteSize(data) <= MAX_DATA_BYTES) return data;
  const out: Record<string, unknown> = { ...data, truncated: true };
  while (byteSize(out) > MAX_DATA_BYTES) {
    let largest: string | null = null;
    for (const [k, v] of Object.entries(out)) {
      if (typeof v !== 'string') continue;
      if (largest === null || byteSize(v) > byteSize(out[largest])) largest = k;
    }
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
    if (tokens.length > 1 && first && !first.op && ASSIGNMENT.test(first.text)) {
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
