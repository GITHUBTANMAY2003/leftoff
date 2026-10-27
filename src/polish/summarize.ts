import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { buildFacts } from '../brief/facts.ts';
import { factsHash } from '../brief/hash.ts';
import { readWorkingState, type WorkingState } from '../collectors/git.ts';
import { loadConfig, type Config, type PolishProviderName } from '../core/config.ts';
import { logError } from '../core/logger.ts';
import { ensureHome, paths } from '../core/paths.ts';
import { ingest } from '../ingest/ingest.ts';
import { openDb } from '../store/db.ts';
import { createRepo, type Repo } from '../store/repo.ts';
import { pickProviders, polishWith } from './chain.ts';
import { buildPolishPrompt } from './prompt.ts';
import type { PolishProvider } from './types.ts';

const POLISH_TIMEOUT_MS = 60_000;
// In the background a local model may first have to load: ollama gets longer
// (owner decision after Task 12). Foreground `--polish` keeps 60 s for all.
const BACKGROUND_TIMEOUTS: Partial<Record<PolishProviderName, number>> = { ollama: 180_000 };
const backgroundTimeout = (name: PolishProviderName) =>
  BACKGROUND_TIMEOUTS[name] ?? POLISH_TIMEOUT_MS;
// Background runs may ingest for longer than foreground commands (owner
// decision after Task 8).
const SUMMARIZE_INGEST_BUDGET_MS = 20_000;
// The lock must outlive the slowest provider, or a second run could start
// while the first is still waiting on it (owner decision after Task 12).
export const SUMMARIZE_LOCK_TTL_MS =
  Math.max(POLISH_TIMEOUT_MS, ...Object.values(BACKGROUND_TIMEOUTS)) + 60_000;

export interface PolishDeps {
  repo: Repo;
  config: Config;
  now: Date;
  working: WorkingState | null;
  providers?: PolishProvider[]; // default: pickProviders(config)
  timeoutFor?: (name: PolishProviderName) => number; // default: 60 s for every provider
  onStart?: (name: PolishProviderName) => void;
}

// Polishes the project's current facts unless a summary for the same facts is
// already saved. Only a successful polish is saved, so a failed run is retried
// next time.
export async function polishNow(
  root: string,
  deps: PolishDeps,
): Promise<{ polished: string | null; provider: string | null }> {
  const { repo, config, now, working } = deps;
  const facts = buildFacts(root, { repo, config, report: null, working, now });
  if (facts.lastActiveAt === null) return { polished: null, provider: null };
  const hash = factsHash(facts);
  const cached = repo.getBrief(root);
  if (cached && cached.factsHash === hash && cached.polished !== null) {
    return { polished: cached.polished, provider: cached.provider };
  }
  const result = await polishWith(
    deps.providers ?? pickProviders(config),
    buildPolishPrompt(facts),
    config,
    deps.timeoutFor ?? (() => POLISH_TIMEOUT_MS),
    deps.onStart,
  );
  if (!result) return { polished: null, provider: null };
  repo.saveBrief(root, hash, JSON.stringify(facts), result.polished, result.provider);
  return result;
}

// `leftoff internal summarize --project <root>` (after SessionEnd): one run per
// project at a time; always ingests; polishes only when polish is on (R-B1).
export async function runInternalSummarize(
  root: string,
  deps: { providers?: PolishProvider[] } = {},
): Promise<void> {
  const config = loadConfig();
  const db = openDb();
  try {
    const repo = createRepo(db);
    // Unique per run, so two runs in one process don't share the lock either.
    const holder = `${process.pid}:${randomUUID()}`;
    const lock = `summarize:${root}`;
    if (!repo.acquireLock(lock, holder, SUMMARIZE_LOCK_TTL_MS)) return;
    try {
      try {
        await ingest({ repo, config, now: new Date() }, { budgetMs: SUMMARIZE_INGEST_BUDGET_MS });
      } catch (err) {
        logError('summarize', err);
      }
      if (config.polish.provider !== 'off') {
        await polishNow(root, {
          repo,
          config,
          now: new Date(),
          working: readWorkingState(root),
          timeoutFor: backgroundTimeout,
          ...(deps.providers ? { providers: deps.providers } : {}),
        });
      }
    } finally {
      repo.releaseLock(lock, holder);
    }
  } finally {
    db.close();
  }
}

// Starts `leftoff internal summarize` in the background and returns at once.
// `cliPath` is the running CLI's entry file (dist/cli.js once built).
export function spawnBackgroundSummarize(root: string, cliPath = process.argv[1] ?? ''): void {
  try {
    ensureHome();
    const child = spawn(process.execPath, [cliPath, 'internal', 'summarize', '--project', root], {
      detached: true,
      stdio: 'ignore',
      env: { ...process.env, LEFTOFF_INTERNAL: '1' },
      cwd: paths().tmp,
    });
    child.on('error', (err) => logError('summarize', err));
    child.unref();
  } catch (err) {
    logError('summarize', err);
  }
}
