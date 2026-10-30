import { existsSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, sep } from 'node:path';
import type { readWorkingState, WorkingState } from '../collectors/git.ts';
import type { Config } from '../core/config.ts';
import type { Repo } from '../store/repo.ts';
import { buildFacts, type LooseEnds } from './facts.ts';

// Loose ends across projects (spec §1.7): every recently active project that
// has a claimed-done contradiction, an open problem or uncommitted files.

const DAY_MS = 86_400_000;
const UNAVAILABLE: WorkingState = { branch: null, files: [], diffStat: null, unavailable: true };

const byTime = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

// Only real projects are loose ends (Task 15b): not a folder under a temp dir
// or an agent's scratchpad, not a folder named like a hash, not an agent's
// config folder, and not a folder outside git that you never used in your
// terminal (an agent's working folder).
export interface ProjectFilter {
  tempDirs: string[];
  isGitRepo: (root: string) => boolean;
}
const AGENT_DIRS = new Set([
  '.claude',
  '.codex',
  '.cursor',
  '.gemini',
  '.aider',
  '.continue',
  '.windsurf',
]);
const HASH_NAME = /^[0-9a-f]{16,}$|^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function systemTempDirs(): string[] {
  const dirs = ['/tmp', '/private/tmp', '/var/folders', '/private/var/folders', tmpdir()];
  try {
    dirs.push(realpathSync(tmpdir()));
  } catch {
    // tmpdir() missing: the others still apply
  }
  return dirs;
}
export const defaultProjectFilter = (): ProjectFilter => ({
  tempDirs: systemTempDirs(),
  isGitRepo: (root) => existsSync(join(root, '.git')),
});

export function isRealProject(root: string, usedInTerminal: boolean, f: ProjectFilter): boolean {
  const segments = root.split(sep);
  if (f.tempDirs.some((d) => root === d || root.startsWith(d.endsWith(sep) ? d : d + sep))) {
    return false;
  }
  if (segments.includes('scratchpad') || segments.some((s) => AGENT_DIRS.has(s))) return false;
  if (HASH_NAME.test(basename(root))) return false;
  return usedInTerminal || f.isGitRepo(root);
}

// claimedDone first, then most open problems, then stale, then oldest activity.
function compare(a: LooseEnds, b: LooseEnds): number {
  return (
    Number(b.claimedDone !== null) - Number(a.claimedDone !== null) ||
    b.openProblems.length - a.openProblems.length ||
    Number(b.stale) - Number(a.stale) ||
    byTime(a.lastActiveAt, b.lastActiveAt)
  );
}

export function buildLooseEnds(deps: {
  repo: Repo;
  config: Config;
  now: Date;
  readWorking: typeof readWorkingState;
  // Past this time (ms since epoch) git is no longer read: the remaining
  // projects show "git status unavailable" (runLoops' 1500 ms budget).
  deadline?: number;
  filter?: ProjectFilter; // default: the system's temp dirs and a `.git` check
}): LooseEnds[] {
  const { repo, config, now } = deps;
  const filter = deps.filter ?? defaultProjectFilter();
  const since = new Date(now.getTime() - config.retentionDays * DAY_MS).toISOString();
  const checked = repo
    .projects()
    .filter((p) => p.lastTs >= since)
    .filter((p) => isRealProject(p.root, repo.hasSource(p.root, 'shell'), filter))
    .sort((a, b) => byTime(b.lastTs, a.lastTs)) // most recently active first
    .slice(0, config.looseEnds.maxProjects);

  const items: LooseEnds[] = [];
  for (const { root, lastTs } of checked) {
    const pastDeadline = deps.deadline !== undefined && Date.now() > deps.deadline;
    const working = pastDeadline ? UNAVAILABLE : deps.readWorking(root);
    const f = buildFacts(root, { repo, config, report: null, working, now });
    const lastActiveAt = f.lastActiveAt ?? lastTs;
    const uncommittedCount = f.unfinished.files.length;
    const gitUnavailable = working.unavailable === true;
    if (!f.claimedDone && f.openProblems.length === 0 && uncommittedCount === 0 && !gitUnavailable)
      continue;
    items.push({
      project: f.project,
      branch: f.branch,
      lastActiveAt,
      stale:
        uncommittedCount > 0 &&
        now.getTime() - Date.parse(lastActiveAt) >= config.looseEnds.staleDays * DAY_MS,
      claimedDone: f.claimedDone,
      openProblems: f.openProblems,
      uncommittedCount,
      gitUnavailable,
    });
  }
  return items.sort(compare);
}
