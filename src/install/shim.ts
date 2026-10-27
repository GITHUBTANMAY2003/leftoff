import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  readFileSync,
  realpathSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { delimiter, join } from 'node:path';
import { ensureHome, paths } from '../core/paths.ts';

// The CLI shim ~/.leftoff/bin/leftoff (R-C4): a POSIX sh script that runs the
// current install with absolute paths, so Claude Code hooks work even when
// `leftoff` is not on the PATH Claude Code sees. Rewritten on every setup.

// Single-quotes a value for sh: ' becomes '\''.
const quote = (s: string) => `'${s.replaceAll("'", `'\\''`)}'`;
const unquote = (s: string) => s.replaceAll(`'\\''`, "'");
const EXEC_LINE = /^exec '((?:[^']|'\\'')*)' '((?:[^']|'\\'')*)' "\$@"$/m;

const realpath = (p: string) => {
  try {
    return realpathSync(p);
  } catch {
    return null;
  }
};

// The node to write into the shim (owner decision after Task 13): the first
// `node` on PATH that is the same binary as execPath, such as Homebrew's
// unversioned /opt/homebrew/bin/node, so upgrading node doesn't break the
// shim; otherwise execPath. fnm's per-shell links are skipped: they disappear
// when that shell exits.
export function stableNodePath(
  execPath: string = process.execPath,
  pathEnv: string = process.env.PATH ?? '',
): string {
  const target = realpath(execPath);
  for (const dir of pathEnv.split(delimiter)) {
    if (dir === '' || dir.includes('fnm_multishells')) continue;
    const candidate = join(dir, 'node');
    if (target !== null && realpath(candidate) === target) return candidate;
  }
  return execPath;
}

export function installShim(nodePath: string, cliPath: string): void {
  ensureHome();
  const shim = paths().shim;
  const tmp = `${shim}.tmp-${process.pid}`;
  const [node, cli] = [quote(nodePath), quote(cliPath)];
  // A missing node or cli exits 0 without a word: hooks must never error.
  // `leftoff doctor` reports the broken shim.
  writeFileSync(
    tmp,
    `#!/bin/sh\n[ -x ${node} ] && [ -r ${cli} ] || exit 0\nexec ${node} ${cli} "$@"\n`,
    {
      mode: 0o700,
    },
  );
  chmodSync(tmp, 0o700); // the mode option is subject to the umask
  renameSync(tmp, shim);
}

export function shimStatus(): {
  exists: boolean;
  nodePath: string | null;
  cliPath: string | null;
  works: boolean;
} {
  const shim = paths().shim;
  if (!existsSync(shim)) return { exists: false, nodePath: null, cliPath: null, works: false };
  const m = EXEC_LINE.exec(readFileSync(shim, 'utf8'));
  const nodePath = m ? unquote(m[1] as string) : null;
  const cliPath = m ? unquote(m[2] as string) : null;
  const works =
    nodePath !== null &&
    cliPath !== null &&
    existsSync(nodePath) &&
    existsSync(cliPath) &&
    spawnSync(shim, ['--version'], { timeout: 1000, stdio: 'ignore' }).status === 0;
  return { exists: true, nodePath, cliPath, works };
}
