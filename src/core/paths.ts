import { chmodSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

export interface Paths {
  home: string;
  db: string;
  config: string;
  shellDir: string;
  shellLog: string;
  binDir: string;
  shim: string;
  logDir: string;
  logFile: string;
  tmp: string;
}

// Re-read on every call so LEFTOFF_HOME changes (tests, child processes) take effect.
export function paths(): Paths {
  const env = process.env.LEFTOFF_HOME;
  const home = env ? resolve(env) : join(homedir(), '.leftoff');
  const shellDir = join(home, 'shell');
  const binDir = join(home, 'bin');
  const logDir = join(home, 'logs');
  return {
    home,
    db: join(home, 'leftoff.db'),
    config: join(home, 'config.json'),
    shellDir,
    shellLog: join(shellDir, 'shell.log'),
    binDir,
    shim: join(binDir, 'leftoff'),
    logDir,
    logFile: join(logDir, 'leftoff.log'),
    tmp: join(home, 'tmp'),
  };
}

export function ensureHome(): void {
  const p = paths();
  for (const dir of [p.home, p.shellDir, p.binDir, p.logDir, p.tmp]) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    // mkdir leaves existing directories alone and is subject to the umask.
    chmodSync(dir, 0o700);
  }
}
