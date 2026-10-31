import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, sep } from 'node:path';
import { buildFacts } from '../../brief/facts.ts';
import { factsHash } from '../../brief/hash.ts';
import { readWorkingState } from '../../collectors/git.ts';
import { compileIgnore } from '../../collectors/ignore.ts';
import { loadConfig, type Config } from '../../core/config.ts';
import { logError } from '../../core/logger.ts';
import { paths } from '../../core/paths.ts';
import { maybeSpawnBackgroundIngest, spawnBackgroundIngest } from '../../ingest/background.ts';
import { resolveProject } from '../../model/project.ts';
import { renderAutoBrief } from '../../render/auto.ts';
import { openDb } from '../../store/db.ts';
import { createRepo, type Repo } from '../../store/repo.ts';

// `leftoff brief --auto` (P7, §1.11): run by the shell hook on terminal open
// and on cd into another project. Uses stored events only (the git working
// state is the one live read), never throws, and prints nothing past 300 ms.

const BUDGET_MS = 300;
const HOUR_MS = 3_600_000;

const quiet = () => Boolean(process.env.LEFTOFF_QUIET);

// Due when the project's last activity is at least gapHours old and no brief
// has been shown since that activity.
export function isBriefDue(root: string, repo: Repo, config: Config, now: Date): boolean {
  if (!config.autoBrief.enabled || quiet()) return false;
  const last = repo.lastActivity(root);
  if (last === null || now.getTime() - Date.parse(last) < config.autoBrief.gapHours * HOUR_MS) {
    return false;
  }
  const shown = repo.briefShownFor(root);
  return shown === null || shown < last;
}

// The "quiet until" marker (Task 16 Step 2a): shell/quiet/<project path with
// % and / escaped> holds the epoch second before which no brief can be due.
// The shell hooks read it without starting a process and skip node until then,
// so `cd` into a project stays cheap. A brief can only become due a gap after
// activity: after the last activity when it hasn't been shown, else (shown, no
// activity yet, or printing switched off) a gap from now; activity that is
// newer but not yet read can only make that later.
export const quietMarkerName = (root: string) => root.replace(/%/g, '%25').replace(/\//g, '%2F');

function quietMarker(root: string): string {
  return join(paths().shellDir, 'quiet', quietMarkerName(root));
}

function writeQuietUntil(root: string, untilMs: number): void {
  try {
    mkdirSync(join(paths().shellDir, 'quiet'), { recursive: true, mode: 0o700 });
    writeFileSync(quietMarker(root), `${Math.floor(untilMs / 1000)}\n`, { mode: 0o600 });
  } catch (err) {
    logError('brief-auto', err); // e.g. a path too long for a file name: node just runs
  }
}

function quietUntilMs(root: string, repo: Repo, config: Config, now: Date): number {
  const gap = config.autoBrief.gapHours * HOUR_MS;
  const last = repo.lastActivity(root);
  const shown = repo.briefShownFor(root);
  const printing = config.autoBrief.enabled && !quiet();
  if (!printing || last === null || (shown !== null && shown >= last)) return now.getTime() + gap;
  return Date.parse(last) + gap;
}

function skipped(root: string, config: Config): boolean {
  const home = paths().home;
  return (
    root === home || root.startsWith(home + sep) || compileIgnore(config).isIgnoredProject(root)
  );
}

export interface BriefAutoDeps {
  now?: Date;
  readWorking?: typeof readWorkingState; // test seam
  spawnIngest?: () => void; // test seam
}

export async function runBriefAuto(cwd: string, deps: BriefAutoDeps = {}): Promise<string> {
  const started = Date.now();
  if (process.env.LEFTOFF_INTERNAL === '1') return '';
  try {
    const root = resolveProject(cwd);
    const config = loadConfig();
    if (skipped(root, config)) {
      const now = deps.now ?? new Date();
      writeQuietUntil(root, now.getTime() + config.autoBrief.gapHours * HOUR_MS);
      return '';
    }
    const now = deps.now ?? new Date();
    const db = openDb();
    try {
      const repo = createRepo(db);
      // Quiet and disabled only stop the printing; the ingest keeps shell.log
      // from piling up either way (owner decision after Task 14).
      maybeSpawnBackgroundIngest(repo, now, deps.spawnIngest ?? (() => spawnBackgroundIngest()));
      if (!isBriefDue(root, repo, config, now)) {
        writeQuietUntil(root, quietUntilMs(root, repo, config, now));
        return '';
      }
      const working = (deps.readWorking ?? readWorkingState)(root);
      const facts = buildFacts(root, { repo, config, report: null, working, now });
      const color = !process.env.NO_COLOR && Boolean(process.stdout.isTTY);
      // A polished summary is shown first while its facts still match (Task 15b).
      const cached = repo.getBrief(root);
      const polished = cached && cached.factsHash === factsHash(facts) ? cached.polished : null;
      const out = renderAutoBrief(facts, { color, now, polished });
      // Too slow: say nothing, and leave the brief due for the next prompt.
      if (Date.now() - started > BUDGET_MS) {
        rmSync(quietMarker(root), { force: true });
        return '';
      }
      repo.markBriefShown(root, repo.lastActivity(root) as string);
      writeQuietUntil(root, now.getTime() + config.autoBrief.gapHours * HOUR_MS);
      return out;
    } finally {
      db.close();
    }
  } catch (err) {
    logError('brief-auto', err);
    return '';
  }
}
