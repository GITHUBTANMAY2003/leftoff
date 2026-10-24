// Event model from spec §1.5. Task 2 needs only the types; Task 3 adds the logic.

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
