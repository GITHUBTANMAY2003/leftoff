import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { hasShell, runInteractive, type ShellName } from './run-shell.ts';

const SCRIPTS = resolve(import.meta.dirname, '../../shell');
let tmp: string;
let home: string; // LEFTOFF_HOME
let log: string;

beforeEach(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), 'leftoff-hooks-')));
  home = join(tmp, 'lhome');
  mkdirSync(join(home, 'shell'), { recursive: true });
  mkdirSync(join(tmp, 'work', 'sub'), { recursive: true });
  log = join(home, 'shell', 'shell.log');
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

interface Line {
  ts: number;
  exit: number;
  duration: number;
  pid: number;
  cwd: string;
  command: string;
}

function readLog(): Line[] {
  if (!existsSync(log)) return [];
  const text = readFileSync(log, 'utf8');
  expect(text === '' || text.endsWith('\n')).toBe(true);
  return text
    .split('\n')
    .filter(Boolean)
    .map((l) => {
      const f = l.split('\t');
      expect(f).toHaveLength(6);
      return {
        ts: Number(f[0]),
        exit: Number(f[1]),
        duration: Number(f[2]),
        pid: Number(f[3]),
        cwd: f[4] as string,
        command: f[5] as string,
      };
    });
}

// What a user types, per shell: silence the prompt, load the hook, cd to a
// work dir. Everything after that is "the session".
function session(shell: ShellName, commands: string[]): string[] {
  const setup =
    shell === 'fish'
      ? ['function fish_prompt; end', `source ${SCRIPTS}/leftoff.fish`]
      : ['PS1=', `source ${SCRIPTS}/leftoff.${shell}`];
  return [...setup, `cd ${join(tmp, 'work')}`, ...commands, 'exit'];
}

const env = (extra: Record<string, string> = {}) => ({
  HOME: tmp,
  LEFTOFF_HOME: home,
  HISTFILE: '/dev/null',
  ...extra,
});

describe.each(['zsh', 'bash', 'fish'] as const)('%s hook', (shell) => {
  const run = test.skipIf(!hasShell(shell));

  run('records successful and failing commands with exit code, pid and cwd', () => {
    const before = Date.now();
    const r = runInteractive(shell, session(shell, ['echo hi', 'ls /nope-leftoff']), env());
    const after = Date.now();
    expect(r.stdout).toContain('hi');
    const lines = readLog();
    const commands = lines.map((l) => l.command);
    expect(commands).toContain('echo hi');
    const hi = lines.find((l) => l.command === 'echo hi') as Line;
    const failed = lines.find((l) => l.command === 'ls /nope-leftoff') as Line;
    expect(hi.exit).toBe(0);
    expect(failed.exit).not.toBe(0);
    expect(hi.cwd).toBe(join(tmp, 'work'));
    expect(hi.pid).toBeGreaterThan(0);
    // bash 3.2 has second resolution only; allow for it.
    expect(hi.ts).toBeGreaterThanOrEqual(Math.floor(before / 1000) * 1000);
    expect(hi.ts).toBeLessThanOrEqual(after);
  });

  run('a command typed with a leading space is not recorded', () => {
    runInteractive(shell, session(shell, [' echo secret-leading-space', 'echo visible']), env());
    const commands = readLog().map((l) => l.command);
    expect(commands).toContain('echo visible');
    expect(commands.join('\n')).not.toContain('secret-leading-space');
  });

  run('LEFTOFF_INTERNAL=1 records nothing', () => {
    runInteractive(shell, session(shell, ['echo hi']), env({ LEFTOFF_INTERNAL: '1' }));
    expect(readLog()).toEqual([]);
  });

  run('a missing log directory records nothing and prints nothing about it', () => {
    rmSync(join(home, 'shell'), { recursive: true });
    const r = runInteractive(shell, session(shell, ['echo hi']), env());
    expect(existsSync(join(home, 'shell'))).toBe(false);
    expect(r.stdout + r.stderr).not.toMatch(/leftoff|shell\.log/);
  });

  run('the log file is created with mode 0600', () => {
    runInteractive(shell, session(shell, ['echo hi']), env());
    expect(statSync(log).mode & 0o777).toBe(0o600);
  });

  run('a real tab in a command becomes a space, so a line always has 6 fields', () => {
    runInteractive(shell, session(shell, ['echo "a\tb"']), env()); // a literal tab character
    // readLog() asserts 6 fields per line.
    expect(readLog().map((l) => l.command)).toContain('echo "a b"');
  });
});

describe('zsh hook details', () => {
  const run = test.skipIf(!hasShell('zsh'));

  run('duration is measured in milliseconds', () => {
    runInteractive('zsh', session('zsh', ['sleep 0.3']), env());
    const sleep = readLog().find((l) => l.command === 'sleep 0.3') as Line;
    expect(sleep.duration).toBeGreaterThanOrEqual(250);
    expect(sleep.duration).toBeLessThan(5000);
  });

  run('cwd is where the command started, not where it ended', () => {
    runInteractive('zsh', session('zsh', ['cd sub']), env());
    expect(readLog().find((l) => l.command === 'cd sub')?.cwd).toBe(join(tmp, 'work'));
  });

  run('a multi-line command is stored on one line', () => {
    runInteractive('zsh', session('zsh', ['echo multi \\', '  line']), env());
    expect(readLog().some((l) => /^echo multi +line$/.test(l.command))).toBe(true);
  });

  run('re-sourcing the hook does not register it twice', () => {
    const r = runInteractive(
      'zsh',
      session('zsh', [
        `source ${SCRIPTS}/leftoff.zsh`,
        'echo "hooks:$precmd_functions"',
        'echo once',
      ]),
      env(),
    );
    expect(r.stdout).toMatch(/^hooks:__leftoff_precmd$/m);
    expect(readLog().filter((l) => l.command === 'echo once')).toHaveLength(1);
  });
});

describe('bash hook details', () => {
  const run = test.skipIf(!hasShell('bash'));

  run('duration is unknown (-1): bash has no start-of-command hook here', () => {
    runInteractive('bash', session('bash', ['echo hi']), env());
    expect(readLog().find((l) => l.command === 'echo hi')?.duration).toBe(-1);
  });

  run('the existing PROMPT_COMMAND is kept and still sees the real exit code', () => {
    const seen = join(tmp, 'seen');
    const lines = [
      'PS1=',
      `PROMPT_COMMAND='echo "user:$?" >> ${seen}'`,
      `source ${SCRIPTS}/leftoff.bash`,
      'false',
      'exit',
    ];
    runInteractive('bash', lines, env());
    expect(readFileSync(seen, 'utf8')).toContain('user:1');
    expect(readLog().find((l) => l.command === 'false')?.exit).toBe(1);
  });

  run('the first prompt does not record the previous session’s last command', () => {
    const histfile = join(tmp, 'history');
    writeFileSync(histfile, 'echo from-previous-session\n');
    runInteractive('bash', session('bash', ['echo now']), env({ HISTFILE: histfile }));
    const commands = readLog().map((l) => l.command);
    expect(commands).toContain('echo now');
    expect(commands.join('\n')).not.toMatch(/from-previous-session|source /);
  });

  run('an empty line does not re-record the previous command', () => {
    runInteractive('bash', session('bash', ['echo once', '', '']), env());
    expect(readLog().filter((l) => l.command === 'echo once')).toHaveLength(1);
  });

  run('re-sourcing the hook does not register it twice', () => {
    const r = runInteractive(
      'bash',
      session('bash', [`source ${SCRIPTS}/leftoff.bash`, 'echo "pc:$PROMPT_COMMAND"', 'echo once']),
      env(),
    );
    expect(r.stdout).toMatch(/^pc:__leftoff_prompt$/m);
    expect(readLog().filter((l) => l.command === 'echo once')).toHaveLength(1);
  });
});
