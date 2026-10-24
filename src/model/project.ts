import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { dirname, basename, join, resolve, sep } from 'node:path';
import { logError } from '../core/logger.ts';
import { paths } from '../core/paths.ts';

const cache = new Map<string, string>();

// The real path, or the resolved path when it doesn't exist (yet).
function real(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    const parent = dirname(path);
    return parent === path ? path : join(real(parent), basename(path));
  }
}

// Project identity (P5): the git top-level directory, or the folder's real path
// outside git. Cached per process; never throws.
export function resolveProject(cwd: string): string {
  const hit = cache.get(cwd);
  if (hit !== undefined) return hit;
  let root: string;
  try {
    const top = execFileSync('git', ['-C', cwd, 'rev-parse', '--show-toplevel'], {
      timeout: 500,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    root = real(top);
  } catch (err) {
    // "Not a git repository" and "git not installed" are normal; a timeout is not.
    if ((err as { signal?: string }).signal) logError('project', `git timed out in ${cwd}`);
    root = real(resolve(cwd));
  }
  cache.set(cwd, root);
  return root;
}

// True for LEFTOFF_HOME itself and anything under it, comparing real paths so a
// symlinked home or the macOS /var → /private/var link can't hide it.
export function isInsideLeftoffHome(path: string): boolean {
  const home = real(paths().home);
  const p = real(resolve(path));
  return p === home || p.startsWith(home + sep);
}
