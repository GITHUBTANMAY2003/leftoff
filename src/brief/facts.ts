import { basename, isAbsolute, relative } from 'node:path';
import type { WorkingState } from '../collectors/git.ts';
import type { Config } from '../core/config.ts';
import type { CollectorName, IngestReport } from '../ingest/ingest.ts';
import { normalizeCommand, type Source, type WorkEvent } from '../model/event.ts';
import type { Repo } from '../store/repo.ts';
import { chooseNextStep } from './next-step.ts';
import { splitSessions } from './sessions.ts';

// Deterministic brief facts (spec §1.7). No AI: everything here comes from
// stored events and the live git state.

export interface BriefFacts {
  project: { root: string; name: string };
  branch: string | null;
  lastActiveAt: string | null;
  window: { from: string; to: string };
  done: string[];
  unfinished: { files: { path: string; status: string }[]; diffStat: string | null };
  lastIntent: string | null;
  lastAgentMessage: string | null;
  openProblems: OpenProblem[];
  claimedDone: ClaimedDone | null;
  notes: string[];
  nextStep: string | null;
  sources: { name: Source; status: 'ok' | 'not_found' | 'error'; detail?: string }[];
}
export interface OpenProblem {
  error: string;
  source: Source;
  firstSeen: string;
  attempts: string[];
}
export interface ClaimedDone {
  source: Source;
  message: string;
  at: string;
  contradictions: string[];
}
export interface LooseEnds {
  project: { root: string; name: string };
  branch: string | null;
  lastActiveAt: string;
  stale: boolean;
  claimedDone: ClaimedDone | null;
  openProblems: OpenProblem[];
  uncommittedCount: number;
}

const DAY_MS = 86_400_000;
const MAX_ATTEMPTS = 5;
const SHOWN_EDITED_FILES = 3;
const SOURCE_ORDER: CollectorName[] = ['claude', 'git', 'shell', 'codex']; // the Sources: line (§1.1)
const FAILURES = new Set(['command_failed', 'tool_error', 'test_failed']);

// "Done" claims (§1.7), plus committed/pushed/merged (R-D1: those are the
// claims that make uncommitted files a contradiction).
const CLAIM =
  /\b(done|completed?|finished|fixed|implemented|committed|pushed|merged|all (tests )?pass(ing|ed)?|ready (for review|to merge))\b/i;
const NEGATION =
  /\b(not|isn't|wasn't|haven't|still)\b.{0,20}\b(done|complete|finished|fixed|passing)\b/i;
const COMMIT_CLAIM = /\b(committed|pushed|merged|ready to merge)\b/i;

const firstLine = (text: string) =>
  text
    .split('\n')
    .find((l) => l.trim() !== '')
    ?.trim() ?? '';

const commandOf = (e: WorkEvent): string | null =>
  typeof e.data.command === 'string' ? normalizeCommand(e.data.command) : null;

// The error to show: the first line of data.error when there is one.
function errorOf(failures: WorkEvent[]): string {
  const withError = [...failures]
    .reverse()
    .find((f) => typeof f.data.error === 'string' && f.data.error.trim());
  return withError
    ? firstLine(withError.data.error as string)
    : (failures.at(-1) as WorkEvent).summary;
}

interface ProblemGroup {
  failures: WorkEvent[]; // unresolved failures of one command, oldest first
  firstIndex: number;
}

// Failures are grouped by normalized command; a later successful run of the
// same command resolves the group. A failure without a command (a tool error)
// is its own group and can't be resolved by a command.
function problemGroups(events: WorkEvent[]): Map<string, ProblemGroup> {
  const groups = new Map<string, ProblemGroup>();
  events.forEach((e, index) => {
    const command = commandOf(e);
    if (FAILURES.has(e.kind)) {
      const key =
        command !== null ? `cmd:${command}` : `${e.kind}:${String(e.data.tool)}:${e.summary}`;
      const group = groups.get(key) ?? { failures: [], firstIndex: index };
      group.failures.push(e);
      groups.set(key, group);
    } else if (e.kind === 'command' && command !== null) {
      groups.delete(`cmd:${command}`);
    }
  });
  return groups;
}

export function findOpenProblems(events: WorkEvent[]): OpenProblem[] {
  return [...problemGroups(events).values()]
    .map((group) => {
      const attempts: string[] = [];
      for (const e of events.slice(group.firstIndex + 1)) {
        if ((e.kind === 'file_edit' || e.kind === 'command') && !attempts.includes(e.summary))
          attempts.push(e.summary);
        if (attempts.length === MAX_ATTEMPTS) break;
      }
      const newest = group.failures.at(-1) as WorkEvent;
      return {
        latest: newest.ts,
        problem: {
          error: errorOf(group.failures),
          source: newest.source,
          firstSeen: (group.failures[0] as WorkEvent).ts,
          attempts,
        },
      };
    })
    .sort((a, b) => (a.latest < b.latest ? 1 : a.latest > b.latest ? -1 : 0)) // newest first
    .map((x) => x.problem);
}

// "Agent said done, but…" (§1.7, R-D1).
export function detectClaimedDone(
  events: WorkEvent[],
  openProblems: OpenProblem[],
  uncommittedCount: number,
): ClaimedDone | null {
  let claimIndex = -1;
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i] as WorkEvent;
    if (e.kind === 'agent_message' && CLAIM.test(e.summary) && !NEGATION.test(e.summary)) {
      claimIndex = i;
      break;
    }
  }
  if (claimIndex === -1) return null;
  const claim = events[claimIndex] as WorkEvent;

  const contradictions: string[] = [];
  const open = new Set(openProblems.map((p) => `${p.firstSeen}\0${p.error}`));
  const groups = [...problemGroups(events).values()].sort((a, b) => b.firstIndex - a.firstIndex);
  for (const group of groups) {
    const error = errorOf(group.failures);
    if (!open.has(`${(group.failures[0] as WorkEvent).ts}\0${error}`)) continue;
    // From the same agent session, or appeared after the claim.
    const sameSession =
      claim.sessionRef !== null && group.failures.some((f) => f.sessionRef === claim.sessionRef);
    const later = group.failures.some((f) => events.indexOf(f) > claimIndex);
    if (sameSession || later) contradictions.push(`${error} (still failing)`);
  }
  const committedSince = events.slice(claimIndex + 1).some((e) => e.kind === 'commit');
  if (COMMIT_CLAIM.test(claim.summary) && uncommittedCount > 0 && !committedSince) {
    contradictions.push(`${uncommittedCount} uncommitted file${uncommittedCount === 1 ? '' : 's'}`);
  }
  if (contradictions.length === 0) return null;
  return { source: claim.source, message: claim.summary, at: claim.ts, contradictions };
}

function editedFilesLine(window: WorkEvent[], root: string): string | null {
  const paths: string[] = [];
  for (const e of window) {
    if (e.kind !== 'file_edit') continue;
    const raw = typeof e.data.path === 'string' ? e.data.path : e.summary.replace(/^\w+ /, '');
    const path = isAbsolute(raw) && raw.startsWith(root + '/') ? relative(root, raw) : raw;
    if (!paths.includes(path)) paths.push(path);
  }
  if (paths.length === 0) return null;
  const shown = paths.slice(0, SHOWN_EDITED_FILES).join(', ');
  const more =
    paths.length > SHOWN_EDITED_FILES ? ` and ${paths.length - SHOWN_EDITED_FILES} more` : '';
  return `Edited ${paths.length} file${paths.length === 1 ? '' : 's'}: ${shown}${more}`;
}

function storedReport(repo: Repo): IngestReport | null {
  try {
    const parsed = JSON.parse(repo.getCursor('ingest', 'last_report') ?? '') as IngestReport;
    return parsed && typeof parsed.perSource === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

function sourcesOf(report: IngestReport | null): BriefFacts['sources'] {
  return SOURCE_ORDER.map((name) => {
    const s = report?.perSource[name];
    if (!s) return { name, status: 'not_found' };
    return s.detail !== undefined
      ? { name, status: s.status, detail: s.detail }
      : { name, status: s.status };
  });
}

export function buildFacts(
  root: string,
  deps: {
    repo: Repo;
    config: Config;
    report: IngestReport | null;
    working: WorkingState | null;
    now: Date;
  },
): BriefFacts {
  const since = new Date(deps.now.getTime() - deps.config.retentionDays * DAY_MS).toISOString();
  const events = deps.repo.eventsForProject(root, since);
  const sessions = splitSessions(events, deps.config.sessionGapMinutes);
  const last = sessions.at(-1) ?? [];
  // The most recent session; with fewer than 3 events, the one before it too.
  const window =
    last.length < 3 && sessions.length > 1 ? [...(sessions.at(-2) as WorkEvent[]), ...last] : last;
  const newest = (kind: string) =>
    [...window].reverse().find((e) => e.kind === kind)?.summary ?? null;

  const commits = window.filter((e) => e.kind === 'commit').map((e) => e.summary);
  const edited = editedFilesLine(window, root);
  const unfinished = deps.working
    ? { files: deps.working.files, diffStat: deps.working.diffStat }
    : { files: [], diffStat: null };
  const openProblems = findOpenProblems(window);
  const nowIso = deps.now.toISOString();

  const facts: Omit<BriefFacts, 'nextStep'> = {
    project: { root, name: basename(root) },
    branch: deps.working?.branch ?? null,
    lastActiveAt: events.at(-1)?.ts ?? null,
    window: { from: window[0]?.ts ?? nowIso, to: window.at(-1)?.ts ?? nowIso },
    done: edited ? [...commits, edited] : commits,
    unfinished,
    lastIntent: newest('user_prompt'),
    lastAgentMessage: newest('agent_message'),
    openProblems,
    claimedDone: detectClaimedDone(window, openProblems, unfinished.files.length),
    notes: events.filter((e) => e.kind === 'note').map((e) => e.summary), // P11: always shown
    sources: sourcesOf(deps.report ?? storedReport(deps.repo)),
  };
  return { ...facts, nextStep: chooseNextStep(facts) };
}
