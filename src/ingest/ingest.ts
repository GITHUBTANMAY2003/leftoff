import { collectors as enabledCollectors } from '../collectors/registry.ts';
import type { CollectContext, CollectResult, Collector } from '../collectors/types.ts';
import { withBudget } from '../core/budget.ts';
import { logError } from '../core/logger.ts';
import type { Source } from '../model/event.ts';

// Runs every collector in isolation and commits what each found (plan Task 8).
// One failing or slow collector never blocks the others or the brief (D10).

export type CollectorName = Exclude<Source, 'user'>;

export interface SourceReport {
  status: 'ok' | 'not_found' | 'error';
  inserted: number;
  warnings: string[];
  detail?: string;
}

export interface IngestReport {
  perSource: Record<CollectorName, SourceReport>;
  prunedEvents: number;
}

const DEFAULT_BUDGET_MS = 1200;
const PRUNE_EVERY_MS = 3_600_000;
const DAY_MS = 86_400_000;

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

export async function ingest(
  ctx: CollectContext,
  // `collectors` defaults to the enabled ones; tests pass their own.
  opts: { budgetMs?: number; collectors?: Collector[] } = {},
): Promise<IngestReport> {
  const list = opts.collectors ?? enabledCollectors(ctx.config);
  const slice = (opts.budgetMs ?? DEFAULT_BUDGET_MS) / Math.max(list.length, 1);
  const disabled = (): SourceReport => ({
    status: 'not_found',
    inserted: 0,
    warnings: [],
    detail: 'disabled',
  });
  const perSource: Record<CollectorName, SourceReport> = {
    claude: disabled(),
    codex: disabled(),
    shell: disabled(),
    git: disabled(),
  };

  for (const collector of list) {
    perSource[collector.name as CollectorName] = await runOne(collector, ctx, slice);
  }

  const report: IngestReport = { perSource, prunedEvents: prune(ctx) };
  ctx.repo.setCursor(
    'ingest',
    'last_report',
    JSON.stringify({ at: ctx.now.toISOString(), ...report }),
  );
  return report;
}

async function runOne(
  collector: Collector,
  ctx: CollectContext,
  budgetMs: number,
): Promise<SourceReport> {
  let result: CollectResult | 'not_found' | undefined;
  try {
    result = await withBudget(
      (async () =>
        (await collector.isAvailable(ctx)) ? collector.collect(ctx) : ('not_found' as const))(),
      budgetMs,
    );
  } catch (err) {
    logError(`ingest:${collector.name}`, err);
    return { status: 'error', inserted: 0, warnings: [], detail: message(err) };
  }
  // A timed-out collector may still finish later; its result is never committed.
  if (result === undefined)
    return { status: 'error', inserted: 0, warnings: [], detail: 'timeout' };
  if (result === 'not_found') return { status: 'not_found', inserted: 0, warnings: [] };

  const done = result;
  let inserted: number;
  try {
    // Events and cursors in one transaction: a crash between them can't skip data.
    inserted = ctx.repo.transaction(() => {
      const n = ctx.repo.insertEvents(done.events);
      for (const c of done.pendingCursors) ctx.repo.setCursor(collector.name, c.key, c.value);
      return n;
    });
  } catch (err) {
    logError(`ingest:${collector.name}`, err);
    return { status: 'error', inserted: 0, warnings: done.warnings, detail: message(err) };
  }

  const warnings = [...done.warnings];
  try {
    await collector.afterCommit?.(ctx);
  } catch (err) {
    logError(`ingest:${collector.name}`, err);
    warnings.push(`afterCommit failed: ${message(err)}`);
  }
  return { status: 'ok', inserted, warnings };
}

// Deletes events older than retentionDays (P9), at most once an hour.
function prune(ctx: CollectContext): number {
  const last = ctx.repo.getCursor('ingest', 'last_prune');
  const now = ctx.now.getTime();
  if (last !== null && now - Date.parse(last) < PRUNE_EVERY_MS) return 0;
  const pruned = ctx.repo.pruneOlderThan(
    new Date(now - ctx.config.retentionDays * DAY_MS).toISOString(),
  );
  ctx.repo.setCursor('ingest', 'last_prune', ctx.now.toISOString());
  return pruned;
}
