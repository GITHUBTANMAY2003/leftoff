import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach } from 'vitest';

const KEYS = [
  'HOME',
  'LEFTOFF_HOME',
  'CLAUDE_CONFIG_DIR',
  'CODEX_HOME',
  'GIT_CONFIG_GLOBAL',
  'LEFTOFF_INTERNAL',
  'LEFTOFF_QUIET',
  'SHELL',
  'PATH',
  'ANTHROPIC_API_KEY',
  'OPENAI_API_KEY',
] as const;

export interface TempHome {
  tmp: string; // the temp root
  home: string; // HOME: rc files live here
  lhome: string; // LEFTOFF_HOME
  bin: string; // first on PATH; fake commands go here
}

// A temp HOME for command tests (plan Task 15): nothing under the developer's
// real home, agent folders or PATH is read or written. Call inside describe or
// at the top of a test file; the returned object is filled in before each test.
export function useTempHome(): TempHome {
  const ctx = {} as TempHome;
  const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
  beforeEach(() => {
    ctx.tmp = realpathSync(mkdtempSync(join(tmpdir(), 'leftoff-cmd-')));
    ctx.home = join(ctx.tmp, 'home');
    ctx.lhome = join(ctx.home, '.leftoff');
    ctx.bin = join(ctx.tmp, 'bin');
    mkdirSync(ctx.home, { recursive: true });
    mkdirSync(ctx.bin);
    process.env.HOME = ctx.home;
    process.env.LEFTOFF_HOME = ctx.lhome;
    process.env.CLAUDE_CONFIG_DIR = join(ctx.home, '.claude');
    process.env.CODEX_HOME = join(ctx.home, '.codex');
    process.env.GIT_CONFIG_GLOBAL = '/dev/null';
    process.env.SHELL = '/bin/zsh';
    process.env.PATH = `${ctx.bin}:/usr/bin:/bin`; // never the real claude, codex or ollama
    delete process.env.LEFTOFF_INTERNAL;
    delete process.env.LEFTOFF_QUIET;
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.OPENAI_API_KEY;
  });
  afterEach(() => {
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    rmSync(ctx.tmp, { recursive: true, force: true });
  });
  return ctx;
}
