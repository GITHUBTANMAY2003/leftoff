import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { loadConfig } from '../core/config.ts';
import { logError } from '../core/logger.ts';
import { ensureHome, paths } from '../core/paths.ts';
import { openDb } from '../store/db.ts';
import { createRepo, type Repo } from '../store/repo.ts';
import { ingest as realIngest } from './ingest.ts';

// Background ingest for terminal-only users (R-D3): `brief --auto` never waits
// for ingest, but starts one in the background at most every 10 minutes, so
// stored data stays fresh and shell.log doesn't pile up.

const EVERY_MS = 10 * 60_000;
const LOCK = 'ingest:bg';
const LOCK_TTL_MS = 120_000;
const BUDGET_MS = 20_000; // larger than the foreground's (owner decision after Task 8)

export function maybeSpawnBackgroundIngest(
  repo: Repo,
  now: Date,
  spawnIngest: () => void = spawnBackgroundIngest,
): boolean {
  const last = repo.getCursor('ingest', 'last_bg');
  if (last !== null && now.getTime() - Date.parse(last) < EVERY_MS) return false;
  repo.setCursor('ingest', 'last_bg', now.toISOString());
  spawnIngest();
  return true;
}

// Starts `leftoff internal ingest` detached and returns at once. `cliPath` is
// the running CLI's entry file (dist/cli.js once built).
export function spawnBackgroundIngest(cliPath = process.argv[1] ?? ''): void {
  try {
    ensureHome();
    const child = spawn(process.execPath, [cliPath, 'internal', 'ingest'], {
      detached: true,
      stdio: 'ignore',
      env: { ...process.env, LEFTOFF_INTERNAL: '1' },
      cwd: paths().tmp,
    });
    child.on('error', (err) => logError('ingest', err));
    child.unref();
  } catch (err) {
    logError('ingest', err);
  }
}

// `leftoff internal ingest`: all projects, one run at a time.
export async function runInternalIngest(deps: { ingest?: typeof realIngest } = {}): Promise<void> {
  const config = loadConfig();
  const db = openDb();
  try {
    const repo = createRepo(db);
    const holder = `${process.pid}:${randomUUID()}`;
    if (!repo.acquireLock(LOCK, holder, LOCK_TTL_MS)) return;
    try {
      await (deps.ingest ?? realIngest)({ repo, config, now: new Date() }, { budgetMs: BUDGET_MS });
    } finally {
      repo.releaseLock(LOCK, holder);
    }
  } finally {
    db.close();
  }
}
