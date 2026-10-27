import { basename, isAbsolute, relative } from 'node:path';
import type { WorkingState } from '../collectors/git.ts';
import type { Config } from '../core/config.ts';
import type { CollectorName, IngestReport } from '../ingest/ingest.ts';
import { isProbeFailure } from '../collectors/probes.ts';
import { isScratchCommand } from '../collectors/scratch.ts';
import { isFilteredExit } from '../collectors/test-failures.ts';
import {
  commandFiles,
  commandKey,
  normalizeCommand,
  withoutFilters,
  type Source,
  type WorkEvent,
} from '../model/event.ts';
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
  command: string | null; // normalized; shown before the error (owner decision after Task 10)
  isTest: boolean; // one of its failures is a failed test run (loose ends count tests)
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
  gitUnavailable: boolean; // git status failed or timed out: "? git status unavailable"
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

// Displayed text is one line (owner decision after Task 13): whitespace is
// collapsed; a multi-line command shows its first line + " …".
const collapse = (text: string) => text.replace(/\s+/g, ' ').trim();
const oneLineCommand = (text: string) => {
  const lines = text.trim().split('\n');
  return lines.length > 1 ? `${collapse(lines[0] as string)} …` : collapse(text);
};
// Stored texts are cut to 300 characters, the start or the end marked with
// "…"; move such a cut to a word boundary.
function quote(text: string | null): string | null {
  if (text === null) return null;
  let t = collapse(text);
  if (t.startsWith('…') && !t.startsWith('… ')) {
    const space = t.indexOf(' ');
    if (space !== -1) t = `…${t.slice(space + 1)}`;
  }
  if (t.endsWith('…') && !t.endsWith(' …')) {
    const space = t.lastIndexOf(' ');
    if (space > 0) t = `${t.slice(0, space).replace(/[\s,;:]+$/, '')}…`;
  }
  return t;
}

// Claims are read sentence by sentence (owner decision after Task 14): a
// question or a sentence that offers options is never a claim.
const QUESTION = /\?["')\]]*$/;
const OFFER = /\b(or|should I|shall I|want me to)\b/i;
function claimSentences(text: string): string[] {
  return text
    .split('\n')
    .flatMap((line) => (quote(line) ?? '').split(/(?<=[.!?])\s+/))
    .filter((s) => CLAIM.test(s) && !QUESTION.test(s) && !OFFER.test(s));
}

// The claim as shown (owner decision after Task 13): the sentence with the
// done-word, at most about 100 characters, cut at word boundaries around it.
const MAX_CLAIM_CHARS = 100;
function claimSentence(sentence: string): string {
  const m = CLAIM.exec(sentence);
  if (!m || [...sentence].length <= MAX_CLAIM_CHARS) return sentence;
  // A window around the done-word, narrowed to whole words.
  let from = Math.max(0, m.index - 45);
  let to = Math.min(sentence.length, from + MAX_CLAIM_CHARS - 2);
  if (from > 0) from = sentence.indexOf(' ', from) + 1;
  if (to < sentence.length) to = sentence.lastIndexOf(' ', to);
  return `${from > 0 ? '…' : ''}${sentence.slice(from, to)}${to < sentence.length ? '…' : ''}`;
}

const AGENTS = new Set<Source>(['claude', 'codex']);
// Scratch failures (owner decision after Task 13) are stored but are not loose
// ends, like probes. Events stored before the rule are classified here too.
const isScratch = (e: WorkEvent) =>
  e.data.scratch === true ||
  (AGENTS.has(e.source) && typeof e.data.command === 'string' && isScratchCommand(e.data.command));

const rawCommand = (e: WorkEvent) => (typeof e.data.command === 'string' ? e.data.command : null);
const outputOf = (e: WorkEvent) => (typeof e.data.error === 'string' ? e.data.error : '');
// Probes are decided again when reading, so older events follow today's list.
const isProbe = (e: WorkEvent) => {
  const command = rawCommand(e);
  return (
    e.data.probe === true ||
    (command !== null &&
      typeof e.data.exitCode === 'number' &&
      isProbeFailure(command, e.data.exitCode, outputOf(e)))
  );
};
// An agent command that only "failed" because the filter it was piped into
// exited non-zero counts as a success (owner decision after Task 13).
const isFilteredPass = (e: WorkEvent) => {
  const command = rawCommand(e);
  return (
    e.kind === 'command_failed' &&
    AGENTS.has(e.source) &&
    command !== null &&
    isFilteredExit(command, outputOf(e))
  );
};
// A success resolves a failure with the same program + subcommand; a failure
// with file arguments only by a run with the same files or none (owner
// decisions after Task 13).
function resolves(success: string, failure: string): boolean {
  if (commandKey(success) !== commandKey(failure)) return false;
  const failed = commandFiles(failure);
  const ran = commandFiles(success);
  return failed.length === 0 || ran.length === 0 || ran.join('\0') === failed.join('\0');
}

const commandOf = (e: WorkEvent): string | null =>
  typeof e.data.command === 'string' ? normalizeCommand(e.data.command) : null;

// The error to show: the first line of data.error when there is one. A
// command that failed without any output shows its exit code instead (the
// command itself is shown next to it, see problemText).
function errorOf(failures: WorkEvent[]): string {
  const withError = [...failures]
    .reverse()
    .find((f) => typeof f.data.error === 'string' && f.data.error.trim());
  if (withError) return firstLine(withError.data.error as string);
  const newest = failures.at(-1) as WorkEvent;
  if (commandOf(newest) === null) return newest.summary;
  return typeof newest.data.exitCode === 'number' ? `exit code ${newest.data.exitCode}` : 'failed';
}

// How an open problem reads everywhere: the failing command first, then the
// error (`npm run lint` — Missing script: "lint"); the error alone without a
// command.
export const problemText = (p: OpenProblem): string =>
  p.command !== null ? `\`${p.command}\` — ${p.error}` : p.error;

export const contradictionOf = (p: OpenProblem): string => `${problemText(p)} (still failing)`;

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
    const succeeded = e.kind === 'command' || isFilteredPass(e);
    if (!succeeded && FAILURES.has(e.kind) && (isProbe(e) || isScratch(e))) return; // stored, not a loose end
    if (!succeeded && FAILURES.has(e.kind)) {
      const key =
        command !== null ? `cmd:${command}` : `${e.kind}:${String(e.data.tool)}:${e.summary}`;
      const group = groups.get(key) ?? { failures: [], firstIndex: index };
      group.failures.push(e);
      groups.set(key, group);
    } else if (succeeded && command !== null) {
      // A filtered pass speaks for the command before the filter.
      const ran = e.kind === 'command' ? command : normalizeCommand(withoutFilters(command));
      for (const [name, group] of groups) {
        const failed = commandOf(group.failures[0] as WorkEvent);
        if (failed !== null && resolves(ran, failed)) groups.delete(name);
      }
    }
  });
  return groups;
}

export function findOpenProblems(events: WorkEvent[]): OpenProblem[] {
  return [...problemGroups(events).values()]
    .map((group) => {
      const attempts: string[] = [];
      for (const e of events.slice(group.firstIndex + 1)) {
        if (e.kind !== 'file_edit' && e.kind !== 'command') continue;
        const attempt = e.kind === 'command' ? oneLineCommand(e.summary) : collapse(e.summary);
        if (!attempts.includes(attempt)) attempts.push(attempt);
        if (attempts.length === MAX_ATTEMPTS) break;
      }
      const newest = group.failures.at(-1) as WorkEvent;
      return {
        latest: newest.ts,
        problem: {
          error: errorOf(group.failures),
          command: commandOf(newest),
          isTest: group.failures.some((f) => f.kind === 'test_failed'),
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
  let sentences: string[] = [];
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i] as WorkEvent;
    if (e.kind !== 'agent_message' || NEGATION.test(e.summary)) continue;
    sentences = claimSentences(e.summary);
    if (sentences.length > 0) {
      claimIndex = i;
      break;
    }
  }
  if (claimIndex === -1) return null;
  const claim = events[claimIndex] as WorkEvent;

  const contradictions: string[] = [];
  const open = new Map(openProblems.map((p) => [`${p.firstSeen}\0${p.error}`, p]));
  const groups = [...problemGroups(events).values()].sort((a, b) => b.firstIndex - a.firstIndex);
  for (const group of groups) {
    const problem = open.get(`${(group.failures[0] as WorkEvent).ts}\0${errorOf(group.failures)}`);
    if (problem === undefined) continue;
    // From the same agent session, or appeared after the claim.
    const sameSession =
      claim.sessionRef !== null && group.failures.some((f) => f.sessionRef === claim.sessionRef);
    const later = group.failures.some((f) => events.indexOf(f) > claimIndex);
    if (sameSession || later) contradictions.push(contradictionOf(problem));
  }
  const committedSince = events.slice(claimIndex + 1).some((e) => e.kind === 'commit');
  if (sentences.some((t) => COMMIT_CLAIM.test(t)) && uncommittedCount > 0 && !committedSince) {
    contradictions.push(`${uncommittedCount} uncommitted file${uncommittedCount === 1 ? '' : 's'}`);
  }
  if (contradictions.length === 0) return null;
  return {
    source: claim.source,
    message: claimSentence(sentences[0] as string),
    at: claim.ts,
    contradictions,
  };
}

// Edited files in first-edit order, relative to the project root.
export function editedPaths(events: WorkEvent[], root: string): string[] {
  const paths: string[] = [];
  for (const e of events) {
    if (e.kind !== 'file_edit') continue;
    const raw = typeof e.data.path === 'string' ? e.data.path : e.summary.replace(/^\w+ /, '');
    const path = isAbsolute(raw) && raw.startsWith(root + '/') ? relative(root, raw) : raw;
    if (!paths.includes(path)) paths.push(path);
  }
  return paths;
}

// "a, b, c and 2 more"
export function shortList(items: string[]): string {
  const shown = items.slice(0, SHOWN_EDITED_FILES).join(', ');
  const rest = items.length - SHOWN_EDITED_FILES;
  return rest > 0 ? `${shown} and ${rest} more` : shown;
}

function editedFilesLine(window: WorkEvent[], root: string): string | null {
  const paths = editedPaths(window, root);
  if (paths.length === 0) return null;
  return `Edited ${paths.length} file${paths.length === 1 ? '' : 's'}: ${shortList(paths)}`;
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
    quote([...window].reverse().find((e) => e.kind === kind)?.summary ?? null);

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
