import { spawn } from 'node:child_process';
import { accessSync, constants } from 'node:fs';
import { delimiter, join } from 'node:path';
import { ensureHome, paths } from '../../core/paths.ts';

// True when `cmd` is an executable file in one of the PATH directories.
export function onPath(cmd: string): boolean {
  return (process.env.PATH ?? '').split(delimiter).some((dir) => {
    if (dir === '') return false;
    try {
      accessSync(join(dir, cmd), constants.X_OK);
      return true;
    } catch {
      return false;
    }
  });
}

// Runs a polish CLI with the prompt on stdin and returns its stdout. Recursion
// guard, second layer (R-C7): env LEFTOFF_INTERNAL=1 and cwd ~/.leftoff/tmp,
// so our own hooks and collectors ignore the run.
export function runCli(
  cmd: string,
  args: string[],
  input: string,
  timeoutMs: number,
): Promise<string> {
  ensureHome();
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd: paths().tmp,
      env: { ...process.env, LEFTOFF_INTERNAL: '1' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`${cmd} timed out after ${timeoutMs} ms`));
    }, timeoutMs);
    child.stdout.on('data', (c: Buffer) => (stdout += c.toString()));
    child.stderr.on('data', (c: Buffer) => (stderr += c.toString()));
    child.stdin.on('error', () => {}); // a CLI that exits without reading stdin
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(stdout);
      else
        reject(
          new Error(`${cmd} failed with exit code ${code}: ${stderr.trim().split('\n')[0] ?? ''}`),
        );
    });
    child.stdin.end(input);
  });
}
