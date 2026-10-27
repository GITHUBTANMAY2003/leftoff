import type { readWorkingState, WorkingState } from '../collectors/git.ts';
import type { Config } from '../core/config.ts';
import type { Repo } from '../store/repo.ts';
import { buildFacts, type LooseEnds } from './facts.ts';

// Loose ends across projects (spec §1.7): every recently active project that
// has a claimed-done contradiction, an open problem or uncommitted files.

const DAY_MS = 86_400_000;
const UNAVAILABLE: WorkingState = { branch: null, files: [], diffStat: null, unavailable: true };

const byTime = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

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
}): LooseEnds[] {
  const { repo, config, now } = deps;
  const since = new Date(now.getTime() - config.retentionDays * DAY_MS).toISOString();
  const checked = repo
    .projects()
    .filter((p) => p.lastTs >= since)
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
