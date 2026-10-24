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

const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=("[^"]*"|'[^']*'|\S*)\s+/;

// For comparing commands (open problems, §1.7): collapse whitespace and strip
// leading VAR=value assignments. A bare assignment is left as it is.
export function normalizeCommand(cmd: string): string {
  let s = cmd.replace(/\s+/g, ' ').trim();
  while (ASSIGNMENT.test(s)) s = s.replace(ASSIGNMENT, '');
  return s;
}
