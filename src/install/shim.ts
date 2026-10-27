import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { ensureHome, paths } from '../core/paths.ts';

// The CLI shim ~/.leftoff/bin/leftoff (R-C4): a POSIX sh script that runs the
// current install with absolute paths, so Claude Code hooks work even when
// `leftoff` is not on the PATH Claude Code sees. Rewritten on every setup.

// Single-quotes a value for sh: ' becomes '\''.
const quote = (s: string) => `'${s.replaceAll("'", `'\\''`)}'`;
const unquote = (s: string) => s.replaceAll(`'\\''`, "'");
const EXEC_LINE = /^exec '((?:[^']|'\\'')*)' '((?:[^']|'\\'')*)' "\$@"$/m;

export function installShim(nodePath: string, cliPath: string): void {
  ensureHome();
  const shim = paths().shim;
  const tmp = `${shim}.tmp-${process.pid}`;
  writeFileSync(tmp, `#!/bin/sh\nexec ${quote(nodePath)} ${quote(cliPath)} "$@"\n`, {
    mode: 0o700,
  });
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
