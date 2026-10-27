import { sep } from 'node:path';
import { buildFacts } from '../../brief/facts.ts';
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
  if (process.env.LEFTOFF_INTERNAL === '1' || quiet()) return '';
  try {
    const root = resolveProject(cwd);
    const config = loadConfig();
    if (!config.autoBrief.enabled || skipped(root, config)) return '';
    const now = deps.now ?? new Date();
    const db = openDb();
    try {
      const repo = createRepo(db);
      maybeSpawnBackgroundIngest(repo, now, deps.spawnIngest ?? (() => spawnBackgroundIngest()));
      if (!isBriefDue(root, repo, config, now)) return '';
      const working = (deps.readWorking ?? readWorkingState)(root);
      const facts = buildFacts(root, { repo, config, report: null, working, now });
      const color = !process.env.NO_COLOR && Boolean(process.stdout.isTTY);
      const out = renderAutoBrief(facts, { color, now });
      // Too slow: say nothing, and leave the brief due for the next prompt.
      if (Date.now() - started > BUDGET_MS) return '';
      repo.markBriefShown(root, repo.lastActivity(root) as string);
      return out;
    } finally {
      db.close();
    }
  } catch (err) {
    logError('brief-auto', err);
    return '';
  }
}
