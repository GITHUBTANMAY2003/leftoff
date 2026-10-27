import { sep } from 'node:path';
import { buildFacts } from '../../brief/facts.ts';
import { factsHash } from '../../brief/hash.ts';
import { readWorkingState } from '../../collectors/git.ts';
import { compileIgnore } from '../../collectors/ignore.ts';
import { withBudget } from '../../core/budget.ts';
import { loadConfig, type Config } from '../../core/config.ts';
import { logError } from '../../core/logger.ts';
import { paths } from '../../core/paths.ts';
import { ingest as realIngest } from '../../ingest/ingest.ts';
import { dedupeKey, makeEvent, type EventKind } from '../../model/event.ts';
import { resolveProject } from '../../model/project.ts';
import { spawnBackgroundSummarize } from '../../polish/summarize.ts';
import { renderAgentContext } from '../../render/markdown.ts';
import { openDb } from '../../store/db.ts';
import { createRepo, type Repo } from '../../store/repo.ts';

// `leftoff hook <name>`: run by the Claude Code plugin (§1.11). Never throws,
// prints nothing but its contract output, and gives up silently past its budget.

export type HookName = 'claude-session-start' | 'claude-stop' | 'claude-session-end';

const START_BUDGET_MS = 2000;
const START_INGEST_BUDGET_MS = 1000;
const EMPTY = { stdout: '' };

interface HookInput {
  sessionId: string | null;
  transcriptPath: string | null;
  cwd: string;
  source: string | null;
  reason: string | null;
}

export interface HookDeps {
  ingest?: typeof realIngest; // test seam
  spawnSummarize?: (root: string) => void;
}

const str = (v: unknown) => (typeof v === 'string' && v !== '' ? v : null);

// Claude Code's hook input; null unless it is a JSON object with a cwd.
function parseInput(stdin: string): HookInput | null {
  let v: unknown;
  try {
    v = JSON.parse(stdin);
  } catch {
    return null;
  }
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const cwd = str(o.cwd);
  if (cwd === null) return null;
  return {
    sessionId: str(o.session_id),
    transcriptPath: str(o.transcript_path),
    cwd,
    source: str(o.source),
    reason: str(o.reason),
  };
}

const SUMMARY: Record<'session_start' | 'checkpoint' | 'session_end', string> = {
  session_start: 'Claude Code session started',
  checkpoint: 'Claude Code turn finished',
  session_end: 'Claude Code session ended',
};

function record(
  repo: Repo,
  root: string,
  input: HookInput,
  kind: 'session_start' | 'checkpoint' | 'session_end',
  data: Record<string, unknown>,
): void {
  const ts = new Date().toISOString();
  repo.insertEvents([
    makeEvent({
      source: 'claude',
      kind: kind satisfies EventKind,
      projectRoot: root,
      ts,
      sessionRef: input.sessionId,
      summary: SUMMARY[kind],
      data,
      dedupeKey: dedupeKey('claude-hook', kind, input.sessionId ?? '', ts),
    }),
  ]);
}

const withoutNulls = (o: Record<string, unknown>) =>
  Object.fromEntries(Object.entries(o).filter(([, v]) => v !== null));

function skipped(root: string, config: Config): boolean {
  const home = paths().home;
  return (
    root === home || root.startsWith(home + sep) || compileIgnore(config).isIgnoredProject(root)
  );
}

// The brief for Claude Code's additionalContext, or '' when the project has no
// earlier events. Records session_start afterwards, so the brief is about the
// work before this session.
async function sessionStart(
  repo: Repo,
  config: Config,
  root: string,
  input: HookInput,
  deps: HookDeps,
): Promise<string> {
  const now = new Date();
  const context = await withBudget(
    (async () => {
      const ingest = deps.ingest ?? realIngest;
      const report = await ingest(
        { repo, config, now, projectFilter: root },
        { budgetMs: START_INGEST_BUDGET_MS },
      );
      if (repo.lastActivity(root) === null) return '';
      const facts = buildFacts(root, {
        repo,
        config,
        report,
        working: readWorkingState(root),
        now,
      });
      const cached = repo.getBrief(root);
      const polished = cached && cached.factsHash === factsHash(facts) ? cached.polished : null;
      return renderAgentContext(facts, polished, { now });
    })(),
    START_BUDGET_MS,
  );
  record(
    repo,
    root,
    input,
    'session_start',
    withoutNulls({
      transcriptPath: input.transcriptPath,
      source: input.source,
    }),
  );
  if (!context) return '';
  return JSON.stringify({
    hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: context },
  });
}

export async function runHook(
  name: HookName,
  stdin: string,
  deps: HookDeps = {},
): Promise<{ stdout: string }> {
  if (process.env.LEFTOFF_INTERNAL === '1') return EMPTY; // recursion guard (R-C7)
  try {
    const input = parseInput(stdin);
    if (!input) return EMPTY;
    const root = resolveProject(input.cwd);
    const config = loadConfig();
    if (skipped(root, config)) return EMPTY;
    const db = openDb();
    try {
      const repo = createRepo(db);
      switch (name) {
        case 'claude-session-start':
          return { stdout: await sessionStart(repo, config, root, input, deps) };
        case 'claude-stop':
          record(
            repo,
            root,
            input,
            'checkpoint',
            withoutNulls({ transcriptPath: input.transcriptPath }),
          );
          return EMPTY;
        case 'claude-session-end':
          record(repo, root, input, 'session_end', withoutNulls({ reason: input.reason }));
          // Always: it ingests, and polishes only if polish is on (R-B1).
          (deps.spawnSummarize ?? spawnBackgroundSummarize)(root);
          return EMPTY;
        default:
          return EMPTY;
      }
    } finally {
      db.close();
    }
  } catch (err) {
    logError('hook', err);
    return EMPTY;
  }
}
