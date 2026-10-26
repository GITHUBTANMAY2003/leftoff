import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { logError } from '../core/logger.ts';
import { dedupeKey, makeEvent, type WorkEvent } from '../model/event.ts';
import { isInsideLeftoffHome } from '../model/project.ts';
import type { CollectContext, CollectResult, Collector } from './types.ts';

// Git collector (plan Task 5): commits and branch switches become events; the
// uncommitted state is read live by readWorkingState (not stored as events).

const execFileAsync = promisify(execFile);
const TIMEOUT_MS = 1000;
const MAX_BUFFER = 1_000_000;
const FIRST_RUN_DAYS = 7;
const DAY_MS = 86_400_000;
const REFLOG_ENTRIES = 1000; // newest entries looked at per run
const FIELD = '\x1f';
const RECORD = '\x1e';

// Never disturb the user's own git use: no index.lock (GIT_OPTIONAL_LOCKS),
// no credential prompts, and output that doesn't depend on their config.
const CONFIG_ARGS = [
  '-c',
  'color.ui=false',
  '-c',
  'log.showSignature=false',
  '-c',
  'core.quotepath=off',
];
const gitEnv = () => ({
  ...process.env,
  GIT_OPTIONAL_LOCKS: '0',
  GIT_TERMINAL_PROMPT: '0',
  LC_ALL: 'C',
});

type GitFailure = 'missing' | 'not-repo' | 'failed';

class GitError extends Error {
  readonly kind: GitFailure;
  constructor(kind: GitFailure, message: string) {
    super(message);
    this.kind = kind;
  }
}

function toGitError(err: unknown): GitError {
  const e = err as { code?: unknown; stderr?: unknown; killed?: boolean; message?: string };
  if (e.code === 'ENOENT') return new GitError('missing', 'git not found on PATH');
  if (String(e.stderr ?? '').includes('not a git repository')) {
    return new GitError('not-repo', 'not a git repository');
  }
  const reason = e.killed ? `timed out after ${TIMEOUT_MS} ms` : String(e.stderr || e.message);
  return new GitError('failed', reason.trim());
}

async function git(root: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await execFileAsync('git', [...CONFIG_ARGS, '-C', root, ...args], {
      timeout: TIMEOUT_MS,
      maxBuffer: MAX_BUFFER,
      env: gitEnv(),
      encoding: 'utf8',
    });
    return stdout;
  } catch (err) {
    throw toGitError(err);
  }
}

function gitSync(root: string, args: string[]): string {
  try {
    return execFileSync('git', [...CONFIG_ARGS, '-C', root, ...args], {
      timeout: TIMEOUT_MS,
      maxBuffer: MAX_BUFFER,
      env: gitEnv(),
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (err) {
    throw toGitError(err);
  }
}

function records(out: string): string[][] {
  return out
    .split(RECORD)
    .map((r) => r.replace(/^\n/, ''))
    .filter(Boolean)
    .map((r) => r.split(FIELD));
}

// One cursor row per project: the last commit seen on HEAD, and the time and
// keys of the newest branch switch seen (reflog times have 1 s resolution, so
// several switches can share the cursor's second).
interface GitCursor {
  commit: string | null;
  reflogAt: string | null;
  reflogKeys: string[];
  noEmailLogged: boolean; // "user.email not set" is logged once per repo, not every run
}

function readCursor(value: string | null): GitCursor {
  try {
    const c = JSON.parse(value ?? '') as Partial<GitCursor>;
    return {
      commit: typeof c.commit === 'string' ? c.commit : null,
      reflogAt: typeof c.reflogAt === 'string' ? c.reflogAt : null,
      reflogKeys: Array.isArray(c.reflogKeys)
        ? c.reflogKeys.filter((k) => typeof k === 'string')
        : [],
      noEmailLogged: c.noEmailLogged === true,
    };
  } catch {
    return { commit: null, reflogAt: null, reflogKeys: [], noEmailLogged: false };
  }
}

const iso = (date: Date | string | number) => new Date(date).toISOString();

// "You" in this repo: its own user.email (it can differ between repos).
async function userEmail(root: string): Promise<string | null> {
  try {
    return (await git(root, ['config', '--get', 'user.email'])).trim() || null;
  } catch (err) {
    if ((err as GitError).kind === 'failed') return null; // exit 1: not set
    throw err;
  }
}

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Only your own commits count as done work (owner decision after Task 5): a
// teammate's commits arrive on HEAD with every pull. Merge commits are skipped.
async function readCommits(
  root: string,
  cursor: string | null,
  email: string | null,
  ctx: CollectContext,
): Promise<{ events: WorkEvent[]; head: string | null }> {
  let head: string;
  try {
    head = (await git(root, ['rev-parse', '--verify', '-q', 'HEAD'])).trim();
  } catch (err) {
    if ((err as GitError).kind === 'failed') return { events: [], head: null }; // no commits yet
    throw err;
  }
  const format = `--format=%H${FIELD}%aI${FIELD}%s${RECORD}`;
  const filters = ['--no-merges', ...(email ? ['-i', `--author=<${escapeRegExp(email)}>`] : [])];
  const firstRun = [
    'log',
    format,
    ...filters,
    `--since=${iso(ctx.now.getTime() - FIRST_RUN_DAYS * DAY_MS)}`,
    'HEAD',
  ];
  let out: string;
  if (cursor === null) {
    out = await git(root, firstRun);
  } else {
    const retention = `--since=${iso(ctx.now.getTime() - ctx.config.retentionDays * DAY_MS)}`;
    try {
      out = await git(root, ['log', format, ...filters, retention, `${cursor}..HEAD`]);
    } catch (err) {
      if ((err as GitError).kind !== 'failed') throw err;
      out = await git(root, firstRun); // cursor commit gone (rebase + gc); dedupe absorbs repeats
    }
  }
  const events = records(out)
    .reverse() // git log is newest first
    .map(([hash = '', date = '', subject = '']) =>
      makeEvent({
        source: 'git',
        kind: 'commit',
        projectRoot: root,
        ts: iso(date),
        sessionRef: null,
        summary: subject,
        data: { hash },
        dedupeKey: dedupeKey('git', root, hash),
      }),
    );
  return { events, head };
}

const SWITCH = /^checkout: moving from (.+) to (.+)$/;

async function readSwitches(
  root: string,
  cursor: GitCursor,
  ctx: CollectContext,
): Promise<{ events: WorkEvent[]; at: string | null; keys: string[] }> {
  let out: string;
  try {
    out = await git(root, [
      'log',
      '-g',
      `-n${REFLOG_ENTRIES}`,
      '--date=iso-strict',
      `--format=%H${FIELD}%gd${FIELD}%gs${RECORD}`,
      'HEAD',
    ]);
  } catch (err) {
    if ((err as GitError).kind === 'failed')
      return { events: [], at: cursor.reflogAt, keys: cursor.reflogKeys };
    throw err; // no reflog yet (no commits) is "failed"; anything else bubbles up
  }
  const floor = cursor.reflogAt ?? iso(ctx.now.getTime() - FIRST_RUN_DAYS * DAY_MS);
  // Oldest first. Identical entries (same second, commit and message, e.g. a
  // script switching back and forth) are told apart by their occurrence number.
  const seen = new Map<string, number>();
  const switches: { at: string; from: string; to: string; key: string }[] = [];
  for (const [hash = '', selector = '', subject = ''] of records(out).reverse()) {
    const match = SWITCH.exec(subject);
    const date = /\{(.+)\}$/.exec(selector)?.[1];
    if (!match || !date) continue;
    const at = iso(date);
    const id = [at, hash, subject].join('\0');
    const occurrence = seen.get(id) ?? 0;
    seen.set(id, occurrence + 1);
    if (at < floor) continue;
    const key = dedupeKey('git', root, 'switch', at, hash, subject, occurrence);
    switches.push({ at, from: match[1] as string, to: match[2] as string, key });
  }

  const events = switches
    .filter((s) => s.at > floor || !cursor.reflogKeys.includes(s.key))
    .map((s) =>
      makeEvent({
        source: 'git',
        kind: 'branch_switch',
        projectRoot: root,
        ts: s.at,
        sessionRef: null,
        summary: `Switched from ${s.from} to ${s.to}`,
        data: { from: s.from, to: s.to },
        dedupeKey: s.key,
      }),
    );
  const newest = switches.at(-1)?.at ?? null;
  if (newest === null) return { events, at: cursor.reflogAt, keys: cursor.reflogKeys };
  return { events, at: newest, keys: switches.filter((s) => s.at === newest).map((s) => s.key) };
}

export const gitCollector: Collector = {
  name: 'git',

  async isAvailable() {
    try {
      await execFileAsync('git', ['--version'], { timeout: TIMEOUT_MS, env: gitEnv() });
      return true;
    } catch {
      return false;
    }
  },

  async collect(ctx: CollectContext): Promise<CollectResult> {
    const result: CollectResult = { events: [], pendingCursors: [], warnings: [] };
    const roots = new Set(ctx.repo.projects().map((p) => p.root));
    if (ctx.projectFilter) roots.add(ctx.projectFilter);
    for (const root of roots) {
      if (isInsideLeftoffHome(root)) continue; // recursion guard (§1.9)
      try {
        const cursor = readCursor(ctx.repo.getCursor('git', root));
        const email = await userEmail(root);
        if (email === null && !cursor.noEmailLogged) {
          logError(
            'git',
            `user.email is not set in ${root}; counting every author's commits as yours`,
          );
        }
        const commits = await readCommits(root, cursor.commit, email, ctx);
        const switches = await readSwitches(root, cursor, ctx);
        result.events.push(...commits.events, ...switches.events);
        const next: GitCursor = {
          commit: commits.head ?? cursor.commit,
          reflogAt: switches.at,
          reflogKeys: switches.keys,
          noEmailLogged: email === null,
        };
        result.pendingCursors.push({ key: root, value: JSON.stringify(next) });
      } catch (err) {
        const e = err instanceof GitError ? err : toGitError(err);
        if (e.kind === 'not-repo') continue; // non-git projects are normal
        result.warnings.push(
          e.kind === 'missing' ? e.message : `git failed in ${root}: ${e.message}`,
        );
        if (e.kind === 'missing') break;
      }
    }
    return result;
  },
};

export interface WorkingState {
  branch: string | null;
  files: { path: string; status: string }[];
  diffStat: string | null;
}

function fileStatus(type: string, xy: string): string {
  if (type === '?') return 'untracked';
  if (type === 'u') return 'conflicted';
  if (type === '2') return xy.includes('C') ? 'copied' : 'renamed';
  if (xy.includes('D')) return 'deleted';
  if (xy[0] === 'A') return 'added';
  return 'modified';
}

// Fields before the path in each `git status --porcelain=v2` record type.
const FIELDS_BEFORE_PATH: Record<string, number> = { '1': 8, '2': 9, u: 10, '?': 1 };

// Live uncommitted state for the brief (Task 9). Never throws: anything that
// goes wrong reads as "no git information".
export function readWorkingState(root: string): WorkingState {
  const empty: WorkingState = { branch: null, files: [], diffStat: null };
  try {
    const entries = gitSync(root, ['status', '--porcelain=v2', '--branch', '-z']).split('\0');
    let oid = '';
    let head = '';
    const files: WorkingState['files'] = [];
    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i] as string;
      if (entry.startsWith('# branch.oid ')) oid = entry.slice('# branch.oid '.length);
      else if (entry.startsWith('# branch.head ')) head = entry.slice('# branch.head '.length);
      const type = entry[0] ?? '';
      const before = FIELDS_BEFORE_PATH[type];
      if (before === undefined || entry[1] !== ' ') continue;
      const parts = entry.split(' ');
      files.push({ path: parts.slice(before).join(' '), status: fileStatus(type, parts[1] ?? '') });
      if (type === '2') i++; // a rename is followed by a record with the old path
    }
    files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    const branch = head === '(detached)' ? `detached@${oid.slice(0, 7)}` : head || null;
    const diffStat =
      oid === '(initial)' ? null : gitSync(root, ['diff', '--shortstat', 'HEAD']).trim() || null;
    return { branch, files, diffStat };
  } catch (err) {
    const e = err instanceof GitError ? err : toGitError(err);
    if (e.kind === 'failed') logError('git', `reading working state of ${root}: ${e.message}`);
    return empty;
  }
}
