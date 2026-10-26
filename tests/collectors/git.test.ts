import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Database } from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { gitCollector, readWorkingState } from '../../src/collectors/git.ts';
import type { CollectContext, CollectResult } from '../../src/collectors/types.ts';
import { DEFAULT_CONFIG, type Config } from '../../src/core/config.ts';
import { readRecentErrors } from '../../src/core/logger.ts';
import { ensureHome, paths } from '../../src/core/paths.ts';
import { makeEvent } from '../../src/model/event.ts';
import { openDb } from '../../src/store/db.ts';
import { createRepo } from '../../src/store/repo.ts';
import { commit, git, initRepo } from '../helpers/git.ts';

let tmp: string;
let db: Database;
let ctx: CollectContext;
const saved = {
  home: process.env.LEFTOFF_HOME,
  path: process.env.PATH,
  globalConfig: process.env.GIT_CONFIG_GLOBAL,
  noSystem: process.env.GIT_CONFIG_NOSYSTEM,
};
const restore = (key: string, value: string | undefined) => {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
};

beforeEach(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), 'leftoff-git-')));
  process.env.LEFTOFF_HOME = join(tmp, 'lhome');
  // The collector's own git calls must not see the developer's global config
  // (their user.email would decide which commits count).
  process.env.GIT_CONFIG_GLOBAL = '/dev/null';
  process.env.GIT_CONFIG_NOSYSTEM = '1';
  ensureHome();
  db = openDb();
  ctx = {
    repo: createRepo(db),
    config: structuredClone(DEFAULT_CONFIG) as Config,
    now: new Date(),
  };
});

afterEach(() => {
  db.close();
  process.env.PATH = saved.path;
  restore('GIT_CONFIG_GLOBAL', saved.globalConfig);
  restore('GIT_CONFIG_NOSYSTEM', saved.noSystem);
  if (saved.home === undefined) delete process.env.LEFTOFF_HOME;
  else process.env.LEFTOFF_HOME = saved.home;
  rmSync(tmp, { recursive: true, force: true });
});

// Makes a project "known", the way any other collector's event would.
function track(root: string): void {
  ctx.repo.insertEvents([
    makeEvent({
      source: 'shell',
      kind: 'command',
      projectRoot: root,
      ts: new Date().toISOString(),
      sessionRef: null,
      summary: 'ls',
      dedupeKey: `track-${root}`,
    }),
  ]);
}

// What ingest (Task 8) does after a successful collect.
async function commitResult(r: CollectResult): Promise<void> {
  ctx.repo.insertEvents(r.events);
  for (const c of r.pendingCursors) ctx.repo.setCursor('git', c.key, c.value);
}

const summaries = (r: CollectResult, kind: string) =>
  r.events.filter((e) => e.kind === kind).map((e) => e.summary);

describe('gitCollector', () => {
  test('emits commits after cursor once', async () => {
    const root = initRepo(tmp, 'app');
    commit(root, 'a');
    commit(root, 'b');
    track(root);
    const first = await gitCollector.collect(ctx);
    expect(summaries(first, 'commit')).toEqual(['a', 'b']);
    await commitResult(first);
    expect((await gitCollector.collect(ctx)).events).toEqual([]);
    commit(root, 'c');
    expect(summaries(await gitCollector.collect(ctx), 'commit')).toEqual(['c']);
  });

  test('a commit event carries hash, author date (UTC) and subject', async () => {
    const root = initRepo(tmp, 'app');
    const hash = commit(root, 'Added reset-token migration', '2026-10-25T09:30:00+05:30');
    track(root);
    ctx.now = new Date('2026-10-26T00:00:00Z');
    const [e] = (await gitCollector.collect(ctx)).events.filter((x) => x.kind === 'commit');
    expect(e).toMatchObject({
      source: 'git',
      kind: 'commit',
      projectRoot: root,
      ts: '2026-10-25T04:00:00.000Z',
      sessionRef: null,
      summary: 'Added reset-token migration',
      data: { hash },
    });
  });

  test('the first run only takes commits from the last 7 days', async () => {
    const root = initRepo(tmp, 'app');
    commit(root, 'old', '2026-10-10T12:00:00Z');
    commit(root, 'recent', '2026-10-24T12:00:00Z');
    track(root);
    ctx.now = new Date('2026-10-26T12:00:00Z');
    expect(summaries(await gitCollector.collect(ctx), 'commit')).toEqual(['recent']);
  });

  test('a cursor pointing at a commit that no longer exists falls back to the last 7 days', async () => {
    const root = initRepo(tmp, 'app');
    commit(root, 'a');
    track(root);
    ctx.repo.setCursor(
      'git',
      root,
      JSON.stringify({ commit: 'f'.repeat(40), reflogAt: null, reflogKeys: [] }),
    );
    const r = await gitCollector.collect(ctx);
    expect(summaries(r, 'commit')).toEqual(['a']);
    expect(r.warnings).toEqual([]);
  });

  test('re-reading without a commit yields the same dedupe keys', async () => {
    const root = initRepo(tmp, 'app');
    commit(root, 'a');
    track(root);
    const keys = (r: CollectResult) => r.events.map((e) => e.dedupeKey);
    expect(keys(await gitCollector.collect(ctx))).toEqual(keys(await gitCollector.collect(ctx)));
  });

  test('emits branch_switch from reflog', async () => {
    const root = initRepo(tmp, 'app');
    commit(root, 'a');
    git(root, ['switch', '-q', '-c', 'feature/forgot-password']);
    git(root, ['checkout', '-q', 'main']);
    track(root);
    const first = await gitCollector.collect(ctx);
    expect(summaries(first, 'branch_switch')).toEqual([
      'Switched from main to feature/forgot-password',
      'Switched from feature/forgot-password to main',
    ]);
    const sw = first.events.find((e) => e.kind === 'branch_switch');
    expect(sw?.data).toMatchObject({ from: 'main', to: 'feature/forgot-password' });
    await commitResult(first);
    expect((await gitCollector.collect(ctx)).events).toEqual([]);
    // A later switch in the same second as the cursor is still emitted once.
    git(root, ['checkout', '-q', 'feature/forgot-password']);
    const next = await gitCollector.collect(ctx);
    expect(summaries(next, 'branch_switch')).toEqual([
      'Switched from main to feature/forgot-password',
    ]);
  });

  test('checks known projects plus the project filter; skips non-git folders silently', async () => {
    const known = initRepo(tmp, 'known');
    const filtered = initRepo(tmp, 'filtered');
    const plain = join(tmp, 'plain');
    mkdirSync(plain);
    commit(known, 'k');
    commit(filtered, 'f');
    track(known);
    track(plain);
    ctx.projectFilter = filtered;
    const r = await gitCollector.collect(ctx);
    expect(summaries(r, 'commit').sort()).toEqual(['f', 'k']);
    expect(r.warnings).toEqual([]);
  });

  test('projects inside LEFTOFF_HOME are ignored', async () => {
    const inside = initRepo(paths().home, 'tmp-repo');
    commit(inside, 'x');
    track(inside);
    expect((await gitCollector.collect(ctx)).events).toEqual([]);
  });

  test('git missing on PATH → warning, no throw; isAvailable false', async () => {
    const root = initRepo(tmp, 'app');
    commit(root, 'a');
    track(root);
    process.env.PATH = join(tmp, 'empty-bin');
    expect(await gitCollector.isAvailable(ctx)).toBe(false);
    const r = await gitCollector.collect(ctx);
    expect(r.events).toEqual([]);
    expect(r.warnings).toEqual([expect.stringMatching(/git/)]);
  });
});

describe('gitCollector: only your own commits (owner decision after Task 5)', () => {
  test("a teammate's commit after a pull is excluded, and the pull's merge commit is skipped", async () => {
    const upstream = initRepo(tmp, 'upstream', 'main', 'mate@example.com');
    commit(upstream, 'teammate base', undefined, 'mate@example.com');
    git(tmp, ['clone', '-q', upstream, 'clone']);
    const root = realpathSync(join(tmp, 'clone'));
    git(root, ['config', 'user.email', 't@example.com']);
    commit(root, 'my work');
    commit(upstream, 'teammate change', undefined, 'mate@example.com');
    git(root, ['pull', '-q', '--no-rebase', '--no-edit', 'origin', 'main']);
    expect(git(root, ['log', '-1', '--format=%s'])).toMatch(/^Merge branch/);
    track(root);
    expect(summaries(await gitCollector.collect(ctx), 'commit')).toEqual(['my work']);
  });

  test('user.email is read per repo: two repos, two different "you"s', async () => {
    const work = initRepo(tmp, 'work', 'main', 'me@work.example');
    const hobby = initRepo(tmp, 'hobby', 'main', 'me@home.example');
    for (const root of [work, hobby]) {
      commit(root, `${root === work ? 'work' : 'hobby'} by work-me`, undefined, 'me@work.example');
      commit(root, `${root === work ? 'work' : 'hobby'} by home-me`, undefined, 'me@home.example');
      track(root);
    }
    const r = await gitCollector.collect(ctx);
    const byRoot = (root: string) =>
      r.events.filter((e) => e.kind === 'commit' && e.projectRoot === root).map((e) => e.summary);
    expect(byRoot(work)).toEqual(['work by work-me']);
    expect(byRoot(hobby)).toEqual(['hobby by home-me']);
  });

  test('the email match ignores case', async () => {
    const root = initRepo(tmp, 'app', 'main', 'Me@Example.com');
    commit(root, 'mine', undefined, 'me@example.COM');
    track(root);
    expect(summaries(await gitCollector.collect(ctx), 'commit')).toEqual(['mine']);
  });

  test('user.email unset: all commits are kept and it is logged once', async () => {
    const root = initRepo(tmp, 'app', 'main', null);
    commit(root, 'mine', undefined, 'me@example.com');
    commit(root, 'theirs', undefined, 'mate@example.com');
    track(root);
    const first = await gitCollector.collect(ctx);
    expect(summaries(first, 'commit')).toEqual(['mine', 'theirs']);
    await commitResult(first);
    commit(root, 'later', undefined, 'mate@example.com');
    expect(summaries(await gitCollector.collect(ctx), 'commit')).toEqual(['later']);
    const logged = readRecentErrors(20).filter((l) => l.includes('user.email'));
    expect(logged).toHaveLength(1);
    expect(logged[0]).toContain(root);
  });
});

describe('readWorkingState', () => {
  test('readWorkingState lists modified and untracked files', () => {
    const root = initRepo(tmp, 'app');
    writeFileSync(join(root, 'email_service.py'), 'v1\n');
    git(root, ['add', '-A']);
    git(root, ['commit', '-q', '-m', 'init']);
    writeFileSync(join(root, 'email_service.py'), 'v2\n');
    writeFileSync(join(root, 'new.txt'), 'n\n');
    expect(readWorkingState(root).files).toEqual([
      { path: 'email_service.py', status: 'modified' },
      { path: 'new.txt', status: 'untracked' },
    ]);
  });

  test('branch name and diff stat summary line', () => {
    const root = initRepo(tmp, 'app', 'feature/forgot-password');
    writeFileSync(join(root, 'a.py'), 'one\n');
    git(root, ['add', '-A']);
    git(root, ['commit', '-q', '-m', 'init']);
    writeFileSync(join(root, 'a.py'), 'one\ntwo\nthree\n');
    const s = readWorkingState(root);
    expect(s.branch).toBe('feature/forgot-password');
    expect(s.diffStat).toBe('1 file changed, 2 insertions(+)');
  });

  test('a clean repo has no files and diffStat null', () => {
    const root = initRepo(tmp, 'app');
    commit(root, 'a');
    expect(readWorkingState(root)).toEqual({ branch: 'main', files: [], diffStat: null });
  });

  test('staged added, deleted and renamed files, and paths with spaces', () => {
    const root = initRepo(tmp, 'app');
    writeFileSync(join(root, 'old name.txt'), 'x\n');
    writeFileSync(join(root, 'gone.txt'), 'y\n');
    git(root, ['add', '-A']);
    git(root, ['commit', '-q', '-m', 'init']);
    git(root, ['mv', 'old name.txt', 'new name.txt']);
    git(root, ['rm', '-q', 'gone.txt']);
    writeFileSync(join(root, 'added.txt'), 'z\n');
    git(root, ['add', 'added.txt']);
    expect(readWorkingState(root).files).toEqual([
      { path: 'added.txt', status: 'added' },
      { path: 'gone.txt', status: 'deleted' },
      { path: 'new name.txt', status: 'renamed' },
    ]);
  });

  test('detached HEAD → detached@<short-sha>', () => {
    const root = initRepo(tmp, 'app');
    const hash = commit(root, 'a');
    git(root, ['checkout', '-q', '--detach']);
    expect(readWorkingState(root).branch).toBe(`detached@${hash.slice(0, 7)}`);
  });

  test('a repo with no commits: branch from HEAD, files listed, no diff stat', () => {
    const root = initRepo(tmp, 'app', 'trunk');
    writeFileSync(join(root, 'first.txt'), 'x\n');
    expect(readWorkingState(root)).toEqual({
      branch: 'trunk',
      files: [{ path: 'first.txt', status: 'untracked' }],
      diffStat: null,
    });
  });

  test('not a repo → empty state, no throw', () => {
    const plain = join(tmp, 'plain');
    mkdirSync(plain);
    expect(readWorkingState(plain)).toEqual({ branch: null, files: [], diffStat: null });
  });

  test('git missing on PATH → empty state, no throw', () => {
    const root = initRepo(tmp, 'app');
    commit(root, 'a');
    process.env.PATH = join(tmp, 'empty-bin');
    expect(readWorkingState(root)).toEqual({ branch: null, files: [], diffStat: null });
  });
});
