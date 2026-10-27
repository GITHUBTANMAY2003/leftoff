import { readWorkingState } from '../../collectors/git.ts';
import { buildLooseEnds } from '../../brief/loose-ends.ts';
import { loadConfig } from '../../core/config.ts';
import { logError } from '../../core/logger.ts';
import { ingest } from '../../ingest/ingest.ts';
import { renderLooseEnds } from '../../render/loose-ends.ts';
import { openDb } from '../../store/db.ts';
import { createRepo } from '../../store/repo.ts';

const INGEST_BUDGET_MS = 1200;
const TOTAL_BUDGET_MS = 1500;

// `leftoff` / `leftoff loops` (§1.10): ingest, then loose ends across every
// project. Projects whose git status can't be read in time are shown, marked.
export async function runLoops(opts: {
  json: boolean;
}): Promise<{ output: string; exitCode: number }> {
  const start = Date.now();
  const config = loadConfig();
  const now = new Date();
  const db = openDb();
  try {
    const repo = createRepo(db);
    try {
      await ingest({ repo, config, now }, { budgetMs: INGEST_BUDGET_MS });
    } catch (err) {
      logError('loops', err); // loose ends still work from what is already stored
    }
    const items = buildLooseEnds({
      repo,
      config,
      now,
      readWorking: readWorkingState,
      deadline: start + TOTAL_BUDGET_MS,
    });
    const color = !process.env.NO_COLOR && Boolean(process.stdout.isTTY);
    const output = opts.json
      ? JSON.stringify(items, null, 2)
      : renderLooseEnds(items, now, { color });
    return { output, exitCode: 0 };
  } finally {
    db.close();
  }
}
