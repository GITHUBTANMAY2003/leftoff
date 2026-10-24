import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { isInsideLeftoffHome, resolveProject } from '../../src/model/project.ts';

let tmp: string;
const savedHome = process.env.LEFTOFF_HOME;

// Isolated from the developer's own git config (signing, hooks, default branch).
const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 't',
  GIT_AUTHOR_EMAIL: 't@example.com',
  GIT_COMMITTER_NAME: 't',
  GIT_COMMITTER_EMAIL: 't@example.com',
};
const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, env: GIT_ENV, stdio: ['ignore', 'pipe', 'ignore'] })
    .toString()
    .trim();

function repo(name: string, commit = true): string {
  const dir = join(tmp, name);
  mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q', '-b', 'main');
  if (commit) git(dir, 'commit', '-q', '--allow-empty', '-m', 'first');
  return realpathSync(dir);
}

beforeEach(() => {
  // realpath: on macOS the temp dir lives behind the /var → /private/var symlink.
  tmp = realpathSync(mkdtempSync(join(tmpdir(), 'leftoff-project-')));
});

afterEach(() => {
  if (savedHome === undefined) delete process.env.LEFTOFF_HOME;
  else process.env.LEFTOFF_HOME = savedHome;
  rmSync(tmp, { recursive: true, force: true });
});

test('resolveProject: subdir of repo → repo root', () => {
  const root = repo('app');
  mkdirSync(join(root, 'a', 'b'), { recursive: true });
  expect(resolveProject(join(root, 'a', 'b'))).toBe(root);
});

test('resolveProject: non-git folder → realpath', () => {
  const dir = join(tmp, 'plain');
  mkdirSync(dir);
  const link = join(tmp, 'link-to-plain');
  symlinkSync(dir, link);
  expect(resolveProject(link)).toBe(dir);
});

test('resolveProject: repo with no commits', () => {
  const root = repo('empty', false);
  mkdirSync(join(root, 'src'));
  expect(resolveProject(join(root, 'src'))).toBe(root);
});

test('resolveProject: detached HEAD', () => {
  const root = repo('detached');
  git(root, 'checkout', '-q', '--detach');
  expect(resolveProject(root)).toBe(root);
});

test('resolveProject: path with spaces', () => {
  const root = repo('my project dir');
  mkdirSync(join(root, 'sub dir'));
  expect(resolveProject(join(root, 'sub dir'))).toBe(root);
});

test('resolveProject: a linked worktree is its own project', () => {
  const root = repo('main-repo');
  const wt = join(tmp, 'wt');
  git(root, 'worktree', 'add', '-q', '-b', 'feature', wt);
  expect(resolveProject(wt)).toBe(realpathSync(wt));
});

test('resolveProject: a nested repo resolves to the inner repo', () => {
  const outer = repo('outer');
  const inner = repo(join('outer', 'inner'));
  expect(resolveProject(inner)).toBe(inner);
  expect(resolveProject(outer)).toBe(outer);
});

test('resolveProject: a missing directory does not throw', () => {
  expect(resolveProject(join(tmp, 'gone', 'x'))).toBe(join(tmp, 'gone', 'x'));
});

test('isInsideLeftoffHome: the home itself and paths under it', () => {
  const home = join(tmp, 'lhome');
  mkdirSync(join(home, 'tmp'), { recursive: true });
  process.env.LEFTOFF_HOME = home;
  expect(isInsideLeftoffHome(home)).toBe(true);
  expect(isInsideLeftoffHome(join(home, 'tmp'))).toBe(true);
  expect(isInsideLeftoffHome(join(home, 'tmp', 'not-created-yet'))).toBe(true);
});

test('isInsideLeftoffHome: a sibling with the same prefix is outside', () => {
  const home = join(tmp, 'lhome');
  mkdirSync(home);
  mkdirSync(join(tmp, 'lhome-other'));
  process.env.LEFTOFF_HOME = home;
  expect(isInsideLeftoffHome(join(tmp, 'lhome-other'))).toBe(false);
  expect(isInsideLeftoffHome(tmp)).toBe(false);
});

test('isInsideLeftoffHome: sees through symlinks', () => {
  const home = join(tmp, 'lhome');
  mkdirSync(join(home, 'tmp'), { recursive: true });
  symlinkSync(home, join(tmp, 'alias'));
  process.env.LEFTOFF_HOME = join(tmp, 'alias');
  expect(isInsideLeftoffHome(join(home, 'tmp'))).toBe(true);
});
