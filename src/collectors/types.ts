import type { Config } from '../core/config.ts';
import type { Source, WorkEvent } from '../model/event.ts';
import type { Repo } from '../store/repo.ts';

export interface CollectContext {
  repo: Repo;
  config: Config;
  now: Date;
  projectFilter?: string;
}

// Collectors only *read* cursors; ingest (Task 8) inserts the events and
// commits pendingCursors in one transaction.
export interface CollectResult {
  events: WorkEvent[];
  pendingCursors: { key: string; value: string }[];
  warnings: string[];
}

// One per source (D4: Cursor, Gemini, Aider can be added later).
export interface Collector {
  name: Source;
  isAvailable(ctx: CollectContext): Promise<boolean>;
  collect(ctx: CollectContext): Promise<CollectResult>;
  // Called by ingest only after this collector's events and cursors were committed (R-B5).
  afterCommit?(ctx: CollectContext): Promise<void>;
}
