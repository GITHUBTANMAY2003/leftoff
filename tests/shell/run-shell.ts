import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export type ShellName = 'zsh' | 'bash' | 'fish';

const BINARIES: Record<ShellName, string> = { zsh: 'zsh', bash: '/bin/bash', fish: 'fish' };

// bash: /bin/bash on purpose — on macOS that is bash 3.2, the version the
// hook must support (plan Task 4). On Linux it is the distro's bash 5.
export function shellBinary(shell: ShellName): string {
  return BINARIES[shell];
}

export function hasShell(shell: ShellName): boolean {
  return spawnSync(shellBinary(shell), ['-c', 'exit 0'], { stdio: 'ignore' }).status === 0;
}

const ARGS: Record<ShellName, string[]> = {
  zsh: ['-f', '-i'], // -f: no rc files; -i: interactive, so preexec/precmd fire
  bash: ['--norc', '--noprofile', '--noediting', '-i'], // no readline: a typed tab stays a tab
  fish: ['--no-config', '-i'],
};

const shellQuote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

// fish only emits fish_preexec/fish_postexec when it reads commands from a
// terminal, so fish runs under a pseudo-terminal made by `script`, whose
// options differ between util-linux (Linux) and BSD (macOS).
type PtyForm = (command: string[]) => string[];
const PTY_FORMS: { probe: string[]; wrap: PtyForm }[] = [
  {
    probe: ['-qec', 'true', '/dev/null'],
    wrap: (command) => ['-qec', command.map(shellQuote).join(' '), '/dev/null'],
  },
  { probe: ['-q', '/dev/null', 'true'], wrap: (command) => ['-q', '/dev/null', ...command] },
];

let ptyForm: PtyForm | null | undefined;
function findPtyForm(): PtyForm | null {
  if (ptyForm === undefined) {
    ptyForm =
      PTY_FORMS.find(
        (f) => spawnSync('script', f.probe, { stdio: 'ignore', timeout: 5000 }).status === 0,
      )?.wrap ?? null;
  }
  return ptyForm;
}

// Why a shell's hook tests can't run here, or null when they can.
export function cannotRun(shell: ShellName): string | null {
  if (!hasShell(shell)) return `${shellBinary(shell)} is not installed`;
  if (shell === 'fish' && !findPtyForm()) {
    return 'no `script` command to run fish under a pseudo-terminal';
  }
  return null;
}

export interface ShellRun {
  stdout: string;
  stderr: string;
  status: number | null;
}

// Runs an interactive shell that reads `lines` from stdin, like a user typing.
// The last line should make the shell exit.
export function runInteractive(
  shell: ShellName,
  lines: string[],
  env: Record<string, string>,
  args: string[] = ARGS[shell],
): Promise<ShellRun> {
  const input = lines.join('\n') + '\n';
  const fullEnv = { PATH: process.env.PATH ?? '/usr/bin:/bin', TERM: 'dumb', ...env };
  const pty = shell === 'fish' ? findPtyForm() : null;
  if (pty) return runUnderPty(pty([shellBinary(shell), ...args]), fullEnv, input);
  return collect(spawn(shellBinary(shell), args, { env: fullEnv }), (child) => {
    child.stdin?.end(input);
  });
}

// macOS `script` rejects a socket or FIFO as stdin or stdout ("tcgetattr/ioctl:
// Operation not supported on socket"), and Node gives children sockets. An
// ordinary shell pipe works. Stdin must also stay open until fish exits: on
// EOF macOS `script` sends ^D and fish quits before running anything. So:
//   { cat input; wait for "done"; } | { script … > output; touch done; }
// The terminal output (stdout and stderr together) comes back as stdout.
async function runUnderPty(
  scriptArgs: string[],
  env: Record<string, string>,
  input: string,
): Promise<ShellRun> {
  const dir = mkdtempSync(join(tmpdir(), 'leftoff-pty-'));
  const files = { input: join(dir, 'input'), done: join(dir, 'done'), output: join(dir, 'output') };
  writeFileSync(files.input, input);
  const pipeline =
    '{ cat "$0"; while [ ! -e "$1" ]; do sleep 0.05; done; } | ' +
    '{ d=$1; o=$2; shift 2; script "$@" > "$o" 2>&1; s=$?; : > "$d"; exit $s; }';
  try {
    const child = spawn(
      'sh',
      ['-c', pipeline, files.input, files.done, files.output, ...scriptArgs],
      {
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    const result = await collect(child, () => {});
    return { ...result, stdout: readFileSync(files.output, 'utf8') + result.stdout };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function collect(
  child: ReturnType<typeof spawn>,
  start: (child: ReturnType<typeof spawn>) => void,
): Promise<ShellRun> {
  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), 15_000);
    child.stdout?.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr?.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
    child.stdin?.on('error', () => {}); // the shell may exit before reading all input
    child.on('error', reject);
    child.on('close', (status) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, status });
    });
    start(child);
  });
}
