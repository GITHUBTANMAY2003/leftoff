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
import { cannotRun, runInteractive, type ShellName } from './run-shell.ts';

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

// Text that would mean a hook printed an error (under a pty the typed input is
// echoed back, so the script's name alone doesn't count).
const HOOK_ERROR =
  /shell\.log|No such file|[Pp]ermission denied|leftoff\.(zsh|bash|fish)( \(line|:)/;

const SHELLS: ShellName[] = ['zsh', 'bash', 'fish'];

describe.each(SHELLS.map((shell) => [shell, cannotRun(shell)] as const))(
  '%s hook',
  (shell, reason) => {
    const run = test.skipIf(reason !== null);
    if (reason) test.skip(`skipped: ${reason}`, () => {});
    const setInternal =
      shell === 'fish' ? 'set -gx LEFTOFF_INTERNAL 1' : 'export LEFTOFF_INTERNAL=1';
    const unsetInternal = shell === 'fish' ? 'set -e LEFTOFF_INTERNAL' : 'unset LEFTOFF_INTERNAL';

    run('records successful and failing commands with exit code, pid and cwd', async () => {
      const before = Date.now();
      const r = await runInteractive(shell, session(shell, ['echo hi', 'ls /nope-leftoff']), env());
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
      // bash 3.2 and fish have second resolution only; allow for it.
      expect(hi.ts).toBeGreaterThanOrEqual(Math.floor(before / 1000) * 1000);
      expect(hi.ts).toBeLessThanOrEqual(after);
    });

    run('a command typed with a leading space is not recorded', async () => {
      await runInteractive(
        shell,
        session(shell, [' echo secret-leading-space', 'echo visible']),
        env(),
      );
      const commands = readLog().map((l) => l.command);
      expect(commands).toContain('echo visible');
      expect(commands.join('\n')).not.toContain('secret-leading-space');
    });

    run(
      'LEFTOFF_INTERNAL=1 records nothing; the same session records once it is unset',
      async () => {
        const commands = ['echo internal-run', unsetInternal, 'echo normal-run', setInternal];
        await runInteractive(shell, session(shell, commands), env({ LEFTOFF_INTERNAL: '1' }));
        const recorded = readLog().map((l) => l.command);
        expect(recorded).toContain('echo normal-run'); // proves the hook is active in this run
        expect(recorded.join('\n')).not.toContain('internal-run');
      },
    );

    run(
      'a missing log directory records nothing and prints nothing; creating it starts recording',
      async () => {
        rmSync(join(home, 'shell'), { recursive: true });
        const r = await runInteractive(
          shell,
          session(shell, ['echo before-dir', `mkdir -p ${join(home, 'shell')}`, 'echo after-dir']),
          env(),
        );
        const recorded = readLog().map((l) => l.command);
        expect(recorded).toContain('echo after-dir'); // proves the hook is active in this run
        expect(recorded.join('\n')).not.toContain('before-dir');
        expect(r.stdout + r.stderr).not.toMatch(HOOK_ERROR);
      },
    );

    run('the log file is created with mode 0600', async () => {
      await runInteractive(shell, session(shell, ['echo hi']), env());
      expect(statSync(log).mode & 0o777).toBe(0o600);
    });

    // fish's line editor (needed for its hooks) completes on a typed tab, so a
    // raw tab can't be typed there; the newline test covers the same code.
    test.skipIf(reason !== null || shell === 'fish')(
      'a real tab in a command becomes a space, so a line always has 6 fields',
      async () => {
        await runInteractive(shell, session(shell, ['echo "a\tb"']), env()); // a literal tab
        // readLog() asserts 6 fields per line.
        expect(readLog().map((l) => l.command)).toContain('echo "a b"');
      },
    );

    run('a newline inside a quoted command becomes a space', async () => {
      await runInteractive(shell, session(shell, ['echo "a', 'b"']), env());
      expect(readLog().map((l) => l.command)).toContain('echo "a b"');
    });
  },
);

describe('zsh hook details', () => {
  const run = test.skipIf(cannotRun('zsh') !== null);

  run('duration is measured in milliseconds', async () => {
    await runInteractive('zsh', session('zsh', ['sleep 0.3']), env());
    const sleep = readLog().find((l) => l.command === 'sleep 0.3') as Line;
    expect(sleep.duration).toBeGreaterThanOrEqual(250);
    expect(sleep.duration).toBeLessThan(5000);
  });

  run('cwd is where the command started, not where it ended', async () => {
    await runInteractive('zsh', session('zsh', ['cd sub']), env());
    expect(readLog().find((l) => l.command === 'cd sub')?.cwd).toBe(join(tmp, 'work'));
  });

  run('a multi-line command is stored on one line', async () => {
    await runInteractive('zsh', session('zsh', ['echo multi \\', '  line']), env());
    expect(readLog().some((l) => /^echo multi +line$/.test(l.command))).toBe(true);
  });

  run('re-sourcing the hook does not register it twice', async () => {
    const r = await runInteractive(
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
  const run = test.skipIf(cannotRun('bash') !== null);

  run('duration is unknown (-1): bash has no start-of-command hook here', async () => {
    await runInteractive('bash', session('bash', ['echo hi']), env());
    expect(readLog().find((l) => l.command === 'echo hi')?.duration).toBe(-1);
  });

  run('the existing PROMPT_COMMAND is kept and still sees the real exit code', async () => {
    const seen = join(tmp, 'seen');
    const lines = [
      'PS1=',
      `PROMPT_COMMAND='echo "user:$?" >> ${seen}'`,
      `source ${SCRIPTS}/leftoff.bash`,
      'false',
      'exit',
    ];
    await runInteractive('bash', lines, env());
    expect(readFileSync(seen, 'utf8')).toContain('user:1');
    expect(readLog().find((l) => l.command === 'false')?.exit).toBe(1);
  });

  run('the first prompt does not record the previous session’s last command', async () => {
    const histfile = join(tmp, 'history');
    writeFileSync(histfile, 'echo from-previous-session\n');
    await runInteractive('bash', session('bash', ['echo now']), env({ HISTFILE: histfile }));
    const commands = readLog().map((l) => l.command);
    expect(commands).toContain('echo now');
    expect(commands.join('\n')).not.toMatch(/from-previous-session|source /);
  });

  run('an empty line does not re-record the previous command', async () => {
    await runInteractive('bash', session('bash', ['echo once', '', '']), env());
    expect(readLog().filter((l) => l.command === 'echo once')).toHaveLength(1);
  });

  run('re-sourcing the hook does not register it twice', async () => {
    const r = await runInteractive(
      'bash',
      session('bash', [`source ${SCRIPTS}/leftoff.bash`, 'echo "pc:$PROMPT_COMMAND"', 'echo once']),
      env(),
    );
    expect(r.stdout).toMatch(/^pc:__leftoff_prompt$/m);
    expect(readLog().filter((l) => l.command === 'echo once')).toHaveLength(1);
  });
});
