import { readWorkingState } from '../../collectors/git.ts';
import { buildFacts } from '../../brief/facts.ts';
import { factsHash } from '../../brief/hash.ts';
import { loadConfig } from '../../core/config.ts';
import { logError } from '../../core/logger.ts';
import { ingest, type IngestReport } from '../../ingest/ingest.ts';
import { resolveProject } from '../../model/project.ts';
import { polishNow } from '../../polish/summarize.ts';
import { renderJson } from '../../render/json.ts';
import { renderMarkdown } from '../../render/markdown.ts';
import { renderTerminal } from '../../render/terminal.ts';
import { openDb } from '../../store/db.ts';
import { createRepo } from '../../store/repo.ts';

const INGEST_BUDGET_MS = 1200;
const POLISH_OFF =
  'Polish is off. Turn it on with `leftoff setup` or `leftoff config set polish.provider <claude-cli|ollama|…>`.';

export interface ResumeOptions {
  cwd: string;
  project?: string;
  format: 'terminal' | 'md' | 'json';
  // `--polish`: run the polish provider now (up to 60 s). Without it a cached
  // polished summary is used only while its facts still match.
  polish: boolean;
}

// `leftoff resume` (§1.10): ingest → live git state → facts → cached polish →
// render → remember the brief was shown. `--polish` polishes before rendering.
export async function runResume(
  opts: ResumeOptions,
): Promise<{ output: string; exitCode: number; stderr?: string }> {
  const root = resolveProject(opts.project ?? opts.cwd);
  const config = loadConfig();
  const now = new Date();
  const db = openDb();
  try {
    const repo = createRepo(db);
    let report: IngestReport | null = null;
    try {
      report = await ingest(
        { repo, config, now, projectFilter: root },
        { budgetMs: INGEST_BUDGET_MS },
      );
    } catch (err) {
      logError('resume', err); // the brief still works from what is already stored
    }
    const working = readWorkingState(root);
    const facts = buildFacts(root, { repo, config, report, working, now });

    if (
      facts.lastActiveAt === null &&
      facts.unfinished.files.length === 0 &&
      opts.format !== 'json'
    ) {
      return {
        output: `No activity recorded yet for ${facts.project.name}. leftoff records your terminal, git and agent work from now on.`,
        exitCode: 0,
      };
    }

    const polishOff = opts.polish && config.polish.provider === 'off';
    if (opts.polish && !polishOff) await polishNow(root, { repo, config, now, working });
    const cached = repo.getBrief(root);
    const polished = cached && cached.factsHash === factsHash(facts) ? cached.polished : null;
    const color = !process.env.NO_COLOR && Boolean(process.stdout.isTTY);
    const output =
      opts.format === 'json'
        ? renderJson(facts, polished)
        : opts.format === 'md'
          ? renderMarkdown(facts, polished, { now })
          : renderTerminal(facts, polished, { color, now });
    if (facts.lastActiveAt) repo.markBriefShown(root, facts.lastActiveAt);
    return { output, exitCode: 0, ...(polishOff ? { stderr: POLISH_OFF } : {}) };
  } finally {
    db.close();
  }
}
