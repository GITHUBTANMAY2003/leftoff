import { basename, isAbsolute, relative } from 'node:path';
import type { WorkingState } from '../collectors/git.ts';
import type { Config } from '../core/config.ts';
import type { CollectorName, IngestReport } from '../ingest/ingest.ts';
import { isProbeFailure } from '../collectors/probes.ts';
import {
  isAgentToolError,
  isLeftoffCommand,
  isLookAround,
  isScratchCommand,
  isStoppedLongRunning,
  referencesTempDir,
} from '../collectors/scratch.ts';
import { isFilteredExit } from '../collectors/test-failures.ts';
import {
  chainSteps,
  commandFiles,
  commandKey,
  displayCommand,
  normalizeCommand,
  withoutFilters,
  type Source,
  type WorkEvent,
} from '../model/event.ts';
import type { Repo } from '../store/repo.ts';
import {
  failureCategory,
  isWholeProjectRun,
  resolvedCategories,
  type FailureCategory,
} from './failure-words.ts';
import { chooseNextStep } from './next-step.ts';
import { readmeOneLiner } from './readme.ts';
import { summarizeWork, type WorkSummary } from './work.ts';
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
  lastAgent: LastAgent | null; // Task 15b: the agent's final message in plain words
  work: WorkSummary; // how much was done over the last stretch of work, and on what
  openProblems: OpenProblem[];
  claimedDone: ClaimedDone | null;
  notes: string[];
  nextStep: string | null;
  sources: { name: Source; status: 'ok' | 'not_found' | 'error'; detail?: string }[];
}
export interface OpenProblem {
  error: string;
  command: string | null; // shown before the error, without setup prefixes and filters (owner decisions after Tasks 10 and 14)
  isTest: boolean; // one of its failures is a failed test run (loose ends count tests)
  source: Source;
  firstSeen: string;
  attempts: string[];
}
export interface LastAgent {
  source: Source;
  update: string; // the first one or two sentences of its final message
  question: string | null; // its last sentence, when that asks you something
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
  workingOn: string | null; // the work summary's topic (compact loose ends)
  lastIntent: string | null; // its fallback
  nextStep: string | null; // in plain words
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
// An agent that paused or hit its limit is not saying it is done (Task 15b).
const PAUSED = /\b(usage limit|rate limit|paused|ran out of (context|tokens|time))\b/i;

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
// A command that references a temp folder is scratch from any source (Task 15b).
const isScratch = (e: WorkEvent) =>
  e.data.scratch === true ||
  (typeof e.data.command === 'string' &&
    (referencesTempDir(e.data.command) ||
      (AGENTS.has(e.source) && isScratchCommand(e.data.command))));
// The agent's tool was refused or misused (Task 15b): never a project problem.
const isAgentToolFailure = (e: WorkEvent) =>
  AGENTS.has(e.source) &&
  isAgentToolError(`${typeof e.data.error === 'string' ? e.data.error : ''}\n${e.summary}`);

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
// The line of an output that says what went wrong: the first one that reads
// like an error, with decoration (=== ___ ***) trimmed; one-word headers such
// as "ERRORS" skipped. Without one, the first line (owner proof run, Task 17).
const ERRORISH =
  /\b(errors?|fail(ed|ure|s)?|panic(ked)?|exception|traceback|refused|denied|not found|no such file|cannot|can't|could not|unable|fatal|killed)\b/i;
function errorLine(output: string): string {
  const lines = output
    .split('\n')
    .map((l) => l.replace(/^[\s=_*#-]+|[\s=_*#-]+$/g, ''))
    .filter((l) => l !== '');
  return lines.find((l) => ERRORISH.test(l) && /\s/.test(l)) ?? firstLine(output);
}

function errorOf(failures: WorkEvent[]): string {
  const withError = [...failures]
    .reverse()
    .find((f) => typeof f.data.error === 'string' && f.data.error.trim());
  if (withError) return errorLine(withError.data.error as string);
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
  lastIndex: number;
}

// You stopped your own command (owner decision after Task 16): exit 129
// (hangup), 130 (Ctrl-C) or 143 (terminate) from your shell. An agent's
// command that ends this way still counts.
// Exit 127 (command not found) from your shell is a typo (owner decision after
// Task 15c); from an agent it is a missing tool and still counts.
const USER_INTERRUPTS = new Set([127, 129, 130, 143]);
const isUserInterrupt = (e: WorkEvent) =>
  e.source === 'shell' &&
  typeof e.data.exitCode === 'number' &&
  USER_INTERRUPTS.has(e.data.exitCode);

// A server, watcher or `tail -f` stopped by a signal, from any source.
const isStoppedServer = (e: WorkEvent) =>
  typeof e.data.command === 'string' &&
  typeof e.data.exitCode === 'number' &&
  isStoppedLongRunning(e.data.command, e.data.exitCode);

const isNotAProblem = (e: WorkEvent) =>
  isProbe(e) || isScratch(e) || isAgentToolFailure(e) || isUserInterrupt(e) || isStoppedServer(e); // stored, not a loose end

// An event that is a commit: from git, or an agent's or your own `git commit`.
const isCommit = (e: WorkEvent) =>
  e.kind === 'commit' ||
  (e.kind === 'command' &&
    typeof e.data.command === 'string' &&
    chainSteps(e.data.command).some((step) => /^git commit\b/.test(normalizeCommand(step))));

// Failures are grouped by normalized command; a later successful run of the
// same command resolves the group. A failure without a command (a tool error)
// is its own group and can't be resolved by a command. Task 15b adds two
// rules: a passing whole-project check resolves every failure of its category
// (a check script: tests, lint, formatting, types and build), and a commit
// after a passing check resolves every failure from before that check.
function problemGroups(events: WorkEvent[]): Map<string, ProblemGroup> {
  const groups = new Map<string, ProblemGroup>();
  let passedCheckAt = -1; // index of the newest passing whole-project check
  events.forEach((e, index) => {
    const command = commandOf(e);
    const succeeded = e.kind === 'command' || isFilteredPass(e);
    if (!succeeded && FAILURES.has(e.kind) && isNotAProblem(e)) return;
    if (!succeeded && FAILURES.has(e.kind)) {
      const key =
        command !== null ? `cmd:${command}` : `${e.kind}:${String(e.data.tool)}:${e.summary}`;
      const group = groups.get(key) ?? { failures: [], firstIndex: index, lastIndex: index };
      group.failures.push(e);
      group.lastIndex = index;
      groups.set(key, group);
      return;
    }
    if (isCommit(e) && passedCheckAt >= 0) {
      for (const [name, group] of groups) if (group.lastIndex < passedCheckAt) groups.delete(name);
    }
    if (succeeded && command !== null) {
      // A filtered pass speaks for the command before the filter.
      const ran = e.kind === 'command' ? command : normalizeCommand(withoutFilters(command));
      // A successful chain ran each of its steps: a whole-project check among
      // them counts too (`npx prettier …; npm run check | grep …`).
      const checks = [ran, ...(chainSteps(ran).length > 1 ? chainSteps(ran) : [])]
        .filter(isWholeProjectRun)
        .map((step) => failureCategory(step) as FailureCategory);
      const covered = checks.flatMap(resolvedCategories);
      if (checks.length > 0) passedCheckAt = index;
      for (const [name, group] of groups) {
        const failed = commandOf(group.failures[0] as WorkEvent);
        if (failed === null) continue;
        const failedCategory = failureCategory(failed);
        const sameCategory = failedCategory !== null && covered.includes(failedCategory);
        if (resolves(ran, failed) || sameCategory) groups.delete(name);
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
          command:
            rawCommand(newest) !== null ? displayCommand(rawCommand(newest) as string) : null,
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
    const head = typeof e.data.head === 'string' ? e.data.head : '';
    if (e.kind !== 'agent_message' || NEGATION.test(e.summary)) continue;
    if (PAUSED.test(e.summary) || PAUSED.test(head)) continue;
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

// Work, as opposed to looking around (Task 15b): an agent turn, an edit, a
// commit, a branch switch or a real failure. A session without any (opening a
// terminal, `leftoff resume`, `git log`, an agent session that only started)
// doesn't move the brief's window.
const WORK_KINDS = new Set([
  'user_prompt',
  'agent_message',
  'file_edit',
  'commit',
  'branch_switch',
]);
const isWork = (e: WorkEvent) =>
  WORK_KINDS.has(e.kind) ||
  (FAILURES.has(e.kind) &&
    !(e.kind === 'command_failed' && isFilteredPass(e)) &&
    !isNotAProblem(e));

// Activity for "last worked": work, or a command that does more than look around.
const isActivity = (e: WorkEvent) =>
  isWork(e) ||
  (e.kind === 'command' && typeof e.data.command === 'string' && !isLookAround(e.data.command));

// The last request as you wrote it: pasted-content tags dropped. A summary the
// agent wrote for itself when its context ran out is not a request.
const NOT_A_REQUEST =
  /^(This session is being continued from a previous conversation|\[Request interrupted by user)/;
const PASTED_TAG = /<\/?pasted_content\b[^>]*>/g;
function lastRequest(window: WorkEvent[]): string | null {
  const prompt = [...window]
    .reverse()
    .find((e) => e.kind === 'user_prompt' && !NOT_A_REQUEST.test(e.summary.trim()));
  return prompt ? quote(prompt.summary.replace(PASTED_TAG, ' ')) : null;
}

// The agent's final message in plain words (Task 15b): its first one or two
// sentences (markdown emphasis dropped), and its last sentence when that asks
// you something — a question, or an offer such as "tell me if you want that".
const MAX_UPDATE_CHARS = 240;
const SECOND_SENTENCE_BELOW = 120;
const ASKS =
  /\?["')\]]*$|\b(tell me|let me know)\b.*\b(if|whether|which)\b|\b(want me to|should I|shall I|would you like)\b/i;
const sentencesOf = (text: string) =>
  text
    .split(/\n\s*\n/)
    .flatMap((paragraph) => (quote(paragraph) ?? '').split(/(?<=[.!?])\s+(?=[A-Z`"*(\d])/))
    .filter((t) => t !== '');
function lastAgentOf(window: WorkEvent[]): LastAgent | null {
  const e = [...window].reverse().find((x) => x.kind === 'agent_message');
  if (!e) return null;
  // Messages stored before 15b keep only their end: start at the first full sentence.
  const start = typeof e.data.head === 'string' ? e.data.head : e.summary;
  let sentences = sentencesOf(start.replace(/\*\*/g, ''));
  if (start.startsWith('…') && sentences.length > 1) sentences = sentences.slice(1);
  sentences = sentences.filter((t) => !t.endsWith('…') || t === sentences[0]);
  const last = sentencesOf(e.summary.replace(/\*\*/g, '')).at(-1) ?? '';
  const question = ASKS.test(last) && !last.startsWith('…') ? last : null;
  // The question is shown on its own, not repeated in the update.
  const [first = '', second] = sentences.filter((t, i) => i === 0 || t !== question);
  const update =
    second !== undefined && [...first].length < SECOND_SENTENCE_BELOW
      ? `${first} ${second}`
      : first;
  return { source: e.source, update: clipText(update, MAX_UPDATE_CHARS), question };
}
const clipText = (text: string, max: number) => {
  const chars = [...text];
  if (chars.length <= max) return text;
  const cut = chars.slice(0, max - 1).join('');
  return `${cut.slice(0, Math.max(cut.lastIndexOf(' '), 1))}…`;
};

// The "where you left off" stretch: the last work session and the ones before
// it, while each break is under 48 h, over at most 14 days. Look-around
// sessions don't count.
const STRETCH_GAP_MS = 48 * 3_600_000;
const STRETCH_MAX_MS = 14 * DAY_MS;
function stretchOf(working: WorkEvent[][]): WorkEvent[] {
  const last = working.at(-1);
  if (last === undefined) return [];
  const end = Date.parse((last.at(-1) as WorkEvent).ts);
  let first = working.length - 1;
  while (first > 0) {
    const prev = working[first - 1] as WorkEvent[];
    const gap =
      Date.parse((working[first] as WorkEvent[])[0]?.ts as string) -
      Date.parse((prev.at(-1) as WorkEvent).ts);
    if (gap >= STRETCH_GAP_MS || end - Date.parse((prev[0] as WorkEvent).ts) > STRETCH_MAX_MS)
      break;
    first--;
  }
  return working.slice(first).flat();
}

export function buildFacts(
  root: string,
  deps: {
    repo: Repo;
    config: Config;
    report: IngestReport | null;
    working: WorkingState | null;
    now: Date;
    readme?: (root: string) => string | null; // test seam; default: the project's README
  },
): BriefFacts {
  const since = new Date(deps.now.getTime() - deps.config.retentionDays * DAY_MS).toISOString();
  // leftoff's own commands are left out entirely (also those stored before).
  const events = deps.repo
    .eventsForProject(root, since)
    .filter((e) => typeof e.data.command !== 'string' || !isLeftoffCommand(e.data.command));
  const sessions = splitSessions(events, deps.config.sessionGapMinutes);
  // The most recent work session; with fewer than 3 events, the one before it
  // too. Sessions that only looked around don't count (Task 15b), but their
  // commands still resolve failures (`after`).
  const working = sessions.filter((session) => session.some(isWork));
  const pool = working.length > 0 ? working : sessions;
  const last = pool.at(-1) ?? [];
  const window =
    last.length < 3 && pool.length > 1 ? [...(pool.at(-2) as WorkEvent[]), ...last] : last;
  const after = sessions.slice(sessions.indexOf(last) + 1).flat();
  const scope = [...window, ...after];
  const newest = (kind: string) =>
    quote([...window].reverse().find((e) => e.kind === kind)?.summary ?? null);

  const commits = window.filter((e) => e.kind === 'commit').map((e) => e.summary);
  const edited = editedFilesLine(window, root);
  const unfinished = deps.working
    ? { files: deps.working.files, diffStat: deps.working.diffStat }
    : { files: [], diffStat: null };
  const openProblems = findOpenProblems(scope);
  const nowIso = deps.now.toISOString();

  const facts: Omit<BriefFacts, 'nextStep'> = {
    project: { root, name: basename(root) },
    branch: deps.working?.branch ?? null,
    lastActiveAt: events.at(-1)?.ts ?? null,
    // "last worked": the last real work, not a look-around after it.
    window: {
      from: window[0]?.ts ?? nowIso,
      to: ([...window].reverse().find(isActivity) ?? window.at(-1))?.ts ?? nowIso,
    },
    done: edited ? [...commits, edited] : commits,
    unfinished,
    lastIntent: lastRequest(window),
    lastAgentMessage: newest('agent_message'),
    lastAgent: lastAgentOf(window),
    work: summarizeWork(stretchOf(working), {
      root,
      branch: deps.working?.branch ?? null,
      gapMinutes: deps.config.sessionGapMinutes,
      about: (deps.readme ?? readmeOneLiner)(root),
    }),
    openProblems,
    claimedDone: detectClaimedDone(scope, openProblems, unfinished.files.length),
    notes: events.filter((e) => e.kind === 'note').map((e) => e.summary), // P11: always shown
    sources: sourcesOf(deps.report ?? storedReport(deps.repo)),
  };
  return { ...facts, nextStep: chooseNextStep(facts) };
}
