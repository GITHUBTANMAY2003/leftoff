import { isAbsolute, relative } from 'node:path';
import type { WorkEvent } from '../model/event.ts';
import { splitSessions } from './sessions.ts';

// How much work was done and what it was about (owner request after Task 17
// started), over the "where you left off" stretch. Deterministic: sessions,
// commits, changed files, the branch name and requests. The size decides how
// long the brief is.

export type WorkSize = 'small' | 'medium' | 'large';

export interface WorkSummary {
  from: string;
  to: string;
  activeMinutes: number; // summed session lengths
  days: number; // calendar days (local time) with work
  commits: string[]; // subjects without their type prefix, oldest first
  filesChanged: number;
  topFolders: { path: string; files: number }[]; // at most 3, most files first
  workingOn: string | null; // "building forgot password", "working on parser and lexer", …
  size: WorkSize;
}

const SMALL_MINUTES = 30;
const LARGE_MINUTES = 240;
const LARGE_COMMITS = 3;
const LARGE_FILES = 20;
const MIN_SESSION_MINUTES = 5; // a session of one event still took some time
const TOP_FOLDERS = 3;
const MAX_REQUEST_CHARS = 100;

// Folders that hold several parts of a project: changes are grouped one level
// deeper inside them (crates/parser, packages/web, src/svc).
const CONTAINERS = new Set([
  'src',
  'lib',
  'libs',
  'crates',
  'packages',
  'apps',
  'services',
  'pkg',
  'cmd',
  'internal',
  'modules',
  'components',
]);

// Conventional-commit type and optional scope: `feat(parser)!: …`.
const COMMIT_PREFIX = /^(\w+)(?:\(([^)]*)\))?!?:\s*/;

// ---- the branch in words ----

const BRANCH_VERBS: Record<string, string> = {
  feat: 'building',
  feature: 'building',
  fix: 'fixing',
  bugfix: 'fixing',
  hotfix: 'fixing',
  refactor: 'refactoring',
  perf: 'speeding up',
  docs: 'writing docs:',
  doc: 'writing docs:',
  test: 'testing',
  tests: 'testing',
  chore: 'doing chores:',
};
const DEFAULT_BRANCHES = new Set(['main', 'master', 'develop', 'dev', 'trunk', 'head', 'wip']);
const TICKET = /^[A-Z][A-Z0-9]+-\d+$/;

// "feature/forgot-password" → "building forgot password";
// "fix/issue-15-s3vectors-error-mapping" → "fixing s3vectors error mapping (issue 15)".
// Null when the name says little (main, wip, feat/m0-m1).
export function branchPhrase(branch: string | null): string | null {
  if (branch === null || branch.startsWith('detached@')) return null;
  const parts = branch.split('/');
  const type = parts.length > 1 ? (parts[0] as string).toLowerCase() : null;
  const verb = type !== null ? (BRANCH_VERBS[type] ?? 'working on') : 'working on';
  const rest = (type !== null && BRANCH_VERBS[type] ? parts.slice(1) : parts).join('-');
  if (DEFAULT_BRANCHES.has(rest.toLowerCase())) return null;
  let ticket: string | null = null;
  const tokens = rest.split(/[-_.\s]+/).filter(Boolean);
  const kept: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i] as string;
    if (/^(issue|gh|ticket)$/i.test(t) && /^\d+$/.test(tokens[i + 1] ?? '')) {
      ticket = `issue ${tokens[i + 1]}`;
      i++;
    } else if (TICKET.test(`${t}-${tokens[i + 1] ?? ''}`) && /^\d+$/.test(tokens[i + 1] ?? '')) {
      ticket = `${t}-${tokens[i + 1]}`;
      i++;
    } else if (/^#?\d+$/.test(t)) {
      ticket ??= `issue ${t.replace('#', '')}`;
    } else kept.push(t);
  }
  const wordy = kept.filter((w) => (w.match(/[a-z]/gi)?.length ?? 0) >= 3);
  if (wordy.length < 2) return null;
  return `${verb} ${kept.join(' ')}${ticket ? ` (${ticket})` : ''}`;
}

// ---- requests ----

const NOT_A_REQUEST =
  /^(This session is being continued|\[Request interrupted by user|<task-notification>|<command-|<local-command|# Files (pasted|mentioned) by the user)/;
const PASTED_TAG = /<\/?pasted_content\b[^>]*>/g;
// Sentences that only acknowledge, approve, continue or ask.
// Hedges and musings ("I guess…", "I mean…", "So…") say how you feel about
// the work, not what it is.
const NOT_SUBSTANTIVE =
  /^(ok|okay|yes|no|sure|great|thanks|thank you|cool|perfect|nice|good|lgtm|approved|go ahead)\b|^(i guess|i think|i mean|i feel|maybe|so|like|um|well|also|and|but)\b|\b(continue|resume|start again|keep going|carry on|where you left off|approved)\b|\?$/i;
const MIN_REQUEST_WORDS = 4;

export function substantiveSentence(prompt: string): string | null {
  const text = prompt.replace(PASTED_TAG, ' ').trim();
  if (NOT_A_REQUEST.test(text)) return null;
  const sentences = text
    .split(/\n+/)
    .map((line) => line.replace(/^(@\S+\s+)+/, '').trim())
    .flatMap((line) => line.split(/(?<=[.!?])\s+(?=\S)/))
    .map((s) => s.replace(/\s+/g, ' ').trim());
  const found = sentences.find(
    (s) =>
      s.split(' ').length >= MIN_REQUEST_WORDS &&
      !NOT_SUBSTANTIVE.test(s) &&
      !s.startsWith('@') &&
      !/^#/.test(s),
  );
  if (found === undefined) return null;
  const chars = [...found];
  if (chars.length <= MAX_REQUEST_CHARS) return found;
  const cut = chars.slice(0, MAX_REQUEST_CHARS - 1).join('');
  return `${cut.slice(0, Math.max(cut.lastIndexOf(' '), 1))}…`;
}

// ---- files and folders ----

function changedFiles(events: WorkEvent[], root: string): string[] {
  const files = new Set<string>();
  const add = (p: string) => {
    const rel = isAbsolute(p) ? relative(root, p) : p;
    // Hidden folders (.github, .vscode, an agent's .superpowers) are tooling.
    const hidden = rel.split('/').some((part) => part.startsWith('.'));
    if (rel !== '' && !rel.startsWith('..') && !isAbsolute(rel) && !hidden) files.add(rel);
  };
  for (const e of events) {
    if (e.kind === 'file_edit' && typeof e.data.path === 'string') add(e.data.path);
    if (e.kind === 'commit' && Array.isArray(e.data.files)) {
      for (const f of e.data.files) if (typeof f === 'string') add(f);
    }
  }
  return [...files];
}

function folderOf(file: string): string {
  const dirs = file.split('/').slice(0, -1);
  if (dirs.length === 0) return '.';
  const first = dirs[0] as string;
  return CONTAINERS.has(first) && dirs.length >= 2 ? `${first}/${dirs[1]}` : first;
}

function topFolders(files: string[]): { path: string; files: number }[] {
  const counts = new Map<string, number>();
  for (const f of files) counts.set(folderOf(f), (counts.get(folderOf(f)) ?? 0) + 1);
  return [...counts]
    .map(([path, n]) => ({ path, files: n }))
    .sort((a, b) => b.files - a.files || (a.path < b.path ? -1 : 1))
    .slice(0, TOP_FOLDERS);
}

// ---- what it was about ----

const joinAnd = (items: string[]) =>
  items.length <= 1 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`;

// Commit scopes that recur (`feat(parser)` twice → parser) when most commits
// have a scope, else the first commit's subject.
function commitTopic(subjects: string[]): string | null {
  if (subjects.length === 0) return null;
  const scopes = subjects
    .map((s) => COMMIT_PREFIX.exec(s)?.[2]?.trim())
    .filter(Boolean) as string[];
  const counts = new Map<string, number>();
  for (const s of scopes) counts.set(s, (counts.get(s) ?? 0) + 1);
  const recurring = [...counts]
    .filter(([, n]) => n >= 2)
    .sort((a, b) => b[1] - a[1])
    .map(([s]) => s);
  if (recurring.length > 0 && scopes.length * 2 >= subjects.length) {
    return `working on ${joinAnd(recurring.slice(0, 3))}`;
  }
  return `working on: ${shortSubject(subjects[0] as string)}`;
}

// How a folder reads: "." (files at the project root) is "the top folder".
export const folderName = (path: string) => (path === '.' ? 'the top folder' : path);

// A topic under 3 words ("working on brief", "building forgot password") says
// little: the newest commit subject follows it (owner decision after 15c).
// A subject already quoted ("working on: …") is left alone.
const MIN_TOPIC_WORDS = 3;
const VERB =
  /^(building|fixing|refactoring|speeding up|writing docs:|testing|doing chores:|working on)\s+/;
function withNewestCommit(phrase: string | null, subjects: string[]): string | null {
  if (phrase === null || phrase.startsWith('working on:') || subjects.length === 0) return phrase;
  const topic = phrase.replace(VERB, '').replace(/\s*\([^)]*\)$/, '');
  const words = topic.split(/[\s,]+/).filter((w) => w !== '' && w !== 'and');
  if (words.length >= MIN_TOPIC_WORDS) return phrase;
  return `${phrase}: ${shortSubject(subjects.at(-1) as string)}`;
}

export const shortSubject = (subject: string) => subject.replace(COMMIT_PREFIX, '').trim();

// ---- time ----

function activeMinutes(events: WorkEvent[], gapMinutes: number): number {
  return splitSessions(events, gapMinutes).reduce((sum, s) => {
    const span =
      (Date.parse((s.at(-1) as WorkEvent).ts) - Date.parse((s[0] as WorkEvent).ts)) / 60_000;
    return sum + Math.max(Math.round(span), MIN_SESSION_MINUTES);
  }, 0);
}

// Days of work: the work splits into periods at idle breaks of 8 hours or more
// (a night's sleep, wherever midnight falls); the days are the distinct local
// dates on which those periods start.
const DAY_BREAK_MS = 8 * 3_600_000;
function workDays(sorted: WorkEvent[]): number {
  const starts: Date[] = [];
  let previous: number | null = null;
  for (const e of sorted) {
    const t = Date.parse(e.ts);
    if (previous === null || t - previous >= DAY_BREAK_MS) starts.push(new Date(t));
    previous = t;
  }
  return new Set(starts.map((d) => `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`)).size;
}

// ---- the summary ----

export function summarizeWork(
  events: WorkEvent[],
  opts: { root: string; branch: string | null; gapMinutes: number },
): WorkSummary {
  const sorted = [...events].sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
  const rawCommits = sorted.filter((e) => e.kind === 'commit').map((e) => e.summary);
  const files = changedFiles(sorted, opts.root);
  const minutes = sorted.length > 0 ? activeMinutes(sorted, opts.gapMinutes) : 0;
  const days = workDays(sorted);
  const folders = topFolders(files);
  const request = sorted
    .filter((e) => e.kind === 'user_prompt')
    .map((e) => substantiveSentence(e.summary))
    .find((s) => s !== null);
  const workingOn =
    withNewestCommit(branchPhrase(opts.branch) ?? commitTopic(rawCommits), rawCommits) ??
    (request ? `working on: ${request}` : null) ??
    (folders.some((f) => f.path !== '.')
      ? `working in ${joinAnd(
          folders
            .filter((f) => f.path !== '.')
            .slice(0, 2)
            .map((f) => f.path),
        )}`
      : null);
  const commits = rawCommits.map(shortSubject);
  const size: WorkSize =
    minutes < SMALL_MINUTES && commits.length <= 1 && days <= 1
      ? 'small'
      : (days >= 2 || minutes >= LARGE_MINUTES) &&
          (commits.length >= LARGE_COMMITS || files.length >= LARGE_FILES)
        ? 'large'
        : 'medium';
  return {
    from: sorted[0]?.ts ?? '',
    to: sorted.at(-1)?.ts ?? '',
    activeMinutes: minutes,
    days,
    commits,
    filesChanged: files.length,
    topFolders: folders,
    workingOn,
    size,
  };
}
