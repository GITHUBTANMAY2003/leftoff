import { execFileSync } from 'node:child_process';
import { mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// git for test fixtures, isolated from the developer's own git config
// (signing, hooks, default branch, aliases).
export const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 't',
  GIT_AUTHOR_EMAIL: 't@example.com',
  GIT_COMMITTER_NAME: 't',
  GIT_COMMITTER_EMAIL: 't@example.com',
};

export function git(cwd: string, args: string[], env: Record<string, string> = {}): string {
  return execFileSync('git', args, {
    cwd,
    env: { ...GIT_ENV, ...env },
    stdio: ['ignore', 'pipe', 'ignore'],
  })
    .toString()
    .trim();
}

export function initRepo(parent: string, name: string, branch = 'main'): string {
  const dir = join(parent, name);
  mkdirSync(dir, { recursive: true });
  git(dir, ['init', '-q', '-b', branch]);
  return realpathSync(dir);
}

// Commits a change to a file named after the subject. `date` sets both author
// and committer date (ISO 8601).
export function commit(root: string, subject: string, date?: string): string {
  writeFileSync(join(root, `${subject.replace(/\W+/g, '_')}.txt`), subject);
  git(root, ['add', '-A']);
  const env: Record<string, string> = date
    ? { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date }
    : {};
  git(root, ['commit', '-q', '-m', subject], env);
  return git(root, ['rev-parse', 'HEAD']);
}
