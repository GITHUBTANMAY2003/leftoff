import { spawnSync } from 'node:child_process';

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

// Runs an interactive shell that reads `lines` from stdin, like a user typing.
export function runInteractive(
  shell: ShellName,
  lines: string[],
  env: Record<string, string>,
  args: string[] = ARGS[shell],
): { stdout: string; stderr: string; status: number | null } {
  const r = spawnSync(shellBinary(shell), args, {
    input: lines.join('\n') + '\n',
    env: { PATH: process.env.PATH ?? '/usr/bin:/bin', TERM: 'dumb', ...env },
    encoding: 'utf8',
    timeout: 15_000,
  });
  return { stdout: r.stdout, stderr: r.stderr, status: r.status };
}
