import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { cannotRun, runInteractive, type ShellName } from './run-shell.ts';

// The shell side of the automatic brief (Task 14): `__leftoff_auto` runs
// `leftoff brief --auto` on the first prompt and whenever the prompt is in a
// different project (git top level, else the folder). A fake `leftoff`
// records each call.

const SCRIPTS = resolve(import.meta.dirname, '../../shell');
let tmp: string;
let home: string;

beforeEach(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), 'leftoff-auto-sh-')));
  home = join(tmp, 'lhome');
  mkdirSync(join(home, 'shell'), { recursive: true });
  mkdirSync(join(tmp, 'projA', 'sub'), { recursive: true });
  mkdirSync(join(tmp, 'projB'));
  spawnSync('git', ['init', '-q', join(tmp, 'projA')], {
    env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null' },
  });
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function fakeLeftoff(file: string, label = 'AUTO'): void {
  mkdirSync(resolve(file, '..'), { recursive: true });
  writeFileSync(file, `#!/bin/sh\necho "${label} $* $PWD"\necho "noise" >&2\n`);
  chmodSync(file, 0o755);
}

function session(shell: ShellName, commands: string[]): string[] {
  const prompt = shell === 'fish' ? 'function fish_prompt; end' : 'PS1=';
  return [prompt, `cd ${tmp}`, `source ${SCRIPTS}/leftoff.${shell}`, ...commands, 'exit'];
}
const env = (extra: Record<string, string> = {}) => ({
  HOME: tmp,
  LEFTOFF_HOME: home,
  HISTFILE: '/dev/null',
  GIT_CONFIG_GLOBAL: '/dev/null',
  ...extra,
});
// Lines the fake printed. Under fish's pty, typed input is echoed too and a
// printed line can follow prompt marks on the same line.
const calls = (out: string) =>
  [...out.matchAll(/(?:AUTO|PATH) brief --auto [^\s]+/g)].map((m) => m[0]);

const SHELLS: ShellName[] = ['zsh', 'bash', 'fish'];

describe.each(SHELLS.map((shell) => [shell, cannotRun(shell)] as const))(
  '%s auto brief',
  (shell, reason) => {
    const run = test.skipIf(reason !== null);
    if (reason) test.skip(`skipped: ${reason}`, () => {});

    run('first prompt, then once per project change; stderr discarded', async () => {
      fakeLeftoff(join(home, 'bin', 'leftoff'));
      const r = await runInteractive(
        shell,
        session(shell, [
          `cd ${join(tmp, 'projA')}`,
          'cd sub', // same git top level: nothing
          'cd ..',
          `cd ${join(tmp, 'projB')}`,
          `cd ${join(tmp, 'projA', 'sub')}`, // back in projA: a different project again
          'true',
        ]),
        env(),
      );
      expect(calls(r.stdout)).toEqual([
        `AUTO brief --auto ${tmp}`,
        `AUTO brief --auto ${join(tmp, 'projA')}`,
        `AUTO brief --auto ${join(tmp, 'projB')}`,
        `AUTO brief --auto ${join(tmp, 'projA', 'sub')}`,
      ]);
      expect(r.stdout + r.stderr).not.toContain('noise');
    });

    run('falls back to leftoff on PATH when the shim is missing', async () => {
      const bin = join(tmp, 'pathbin');
      fakeLeftoff(join(bin, 'leftoff'), 'PATH');
      const r = await runInteractive(
        shell,
        session(shell, ['true']),
        env({ PATH: `${bin}:${process.env.PATH ?? '/usr/bin:/bin'}` }),
      );
      expect(calls(r.stdout)).toEqual([`PATH brief --auto ${tmp}`]);
    });

    run('LEFTOFF_QUIET set, or no leftoff at all: nothing runs, nothing printed', async () => {
      fakeLeftoff(join(home, 'bin', 'leftoff'));
      const quiet = await runInteractive(
        shell,
        session(shell, [`cd ${join(tmp, 'projA')}`]),
        env({ LEFTOFF_QUIET: '1' }),
      );
      expect(calls(quiet.stdout)).toEqual([]);
      rmSync(join(home, 'bin'), { recursive: true });
      const none = await runInteractive(shell, session(shell, [`cd ${join(tmp, 'projA')}`]), env());
      expect(calls(none.stdout)).toEqual([]);
      expect(none.stdout + none.stderr).not.toMatch(/not found|No such file|leftoff: /);
    });
  },
);
