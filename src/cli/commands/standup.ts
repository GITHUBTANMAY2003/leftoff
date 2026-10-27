import { spawnSync } from 'node:child_process';
import { readWorkingState } from '../../collectors/git.ts';
import { buildFacts } from '../../brief/facts.ts';
import { loadConfig } from '../../core/config.ts';
import { logError } from '../../core/logger.ts';
import { parseSince } from '../../core/time.ts';
import { ingest, type IngestReport } from '../../ingest/ingest.ts';
import { resolveProject } from '../../model/project.ts';
import { buildStandup, renderStandup } from '../../render/standup.ts';
import { openDb } from '../../store/db.ts';
import { createRepo } from '../../store/repo.ts';

const INGEST_BUDGET_MS = 1200;
const CLIPBOARD_TOOLS: [string, string[]][] = [
  ['pbcopy', []],
  ['wl-copy', []],
  ['xclip', ['-selection', 'clipboard']],
];

export interface StandupOptions {
  cwd: string;
  since?: string;
  all: boolean;
  copy: boolean;
}

// The start of the previous local day; on Mondays, the start of Friday.
export function defaultSince(now: Date): Date {
  const back = now.getDay() === 1 ? 3 : 1;
  return new Date(now.getFullYear(), now.getMonth(), now.getDate() - back);
}

// --copy: the first clipboard tool that is installed and accepts the text.
export function copyToClipboard(text: string): string {
  for (const [cmd, args] of CLIPBOARD_TOOLS) {
    const r = spawnSync(cmd, args, { input: text, stdio: ['pipe', 'ignore', 'ignore'] });
    if (!r.error && r.status === 0) return '(copied)';
  }
  return '(clipboard tool not found)';
}

// `leftoff standup` (§1.10): ingest, then Yesterday from the events since
// `since`, Today and Blockers from each project's brief facts.
export async function runStandup(
  opts: StandupOptions,
): Promise<{ output: string; exitCode: number }> {
  const now = new Date();
  const since = opts.since !== undefined ? parseSince(opts.since, now) : defaultSince(now);
  const root = opts.all ? null : resolveProject(opts.cwd);
  const config = loadConfig();
  const db = openDb();
  try {
    const repo = createRepo(db);
    let report: IngestReport | null = null;
    try {
      report = await ingest(
        { repo, config, now, ...(root !== null ? { projectFilter: root } : {}) },
        { budgetMs: INGEST_BUDGET_MS },
      );
    } catch (err) {
      logError('standup', err); // the standup still works from what is already stored
    }
    const sinceIso = since.toISOString();
    const eventsSince =
      root !== null ? repo.eventsForProject(root, sinceIso) : repo.eventsSince(sinceIso);
    // --all: every project with work since then, most recently active first.
    const roots =
      root !== null ? [root] : [...new Set(eventsSince.map((e) => e.projectRoot).reverse())];
    const factsByProject = roots.map((r) =>
      buildFacts(r, { repo, config, report, working: readWorkingState(r), now }),
    );
    let output = renderStandup(buildStandup({ factsByProject, eventsSince }, { prefix: opts.all }));
    if (opts.copy) output += `\n${copyToClipboard(output)}`;
    return { output, exitCode: 0 };
  } finally {
    db.close();
  }
}
