import type { Config } from '../core/config.ts';
import type { Source, WorkEvent } from '../model/event.ts';
import type { Repo } from '../store/repo.ts';

export interface CollectContext {
  repo: Repo;
  config: Config;
  now: Date;
  projectFilter?: string;
  // Soft deadline (epoch ms). Collectors always finish their first unit of work
  // (a file, a chunk, a project), then stop starting new units once it has
  // passed and return what they completed, so every run commits progress even
  // on a large backlog. Ingest also keeps a hard timeout as a safety net.
  deadline?: number;
}

export function pastDeadline(ctx: CollectContext): boolean {
  return ctx.deadline !== undefined && Date.now() >= ctx.deadline;
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
