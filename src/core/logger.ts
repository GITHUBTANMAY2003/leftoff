import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync } from 'node:fs';
import { paths } from './paths.ts';

const MAX_BYTES = 1024 * 1024;

function describe(err: unknown): string {
  if (err instanceof Error) return err.stack ?? `${err.name}: ${err.message}`;
  return String(err);
}

// Appends one line per error. Never throws: logging must not break the caller.
export function logError(scope: string, err: unknown): void {
  try {
    const { logDir, logFile } = paths();
    const message = describe(err).replace(/\s*\r?\n\s*/g, ' | ');
    const line = `${new Date().toISOString()} [${scope}] ${message}\n`;
    mkdirSync(logDir, { recursive: true, mode: 0o700 });
    if (existsSync(logFile) && statSync(logFile).size + Buffer.byteLength(line) > MAX_BYTES) {
      renameSync(logFile, `${logFile}.1`);
    }
    appendFileSync(logFile, line, { mode: 0o600 });
  } catch {
    // Nowhere left to report this.
  }
}

function readLines(file: string): string[] {
  try {
    return readFileSync(file, 'utf8').split('\n').filter(Boolean);
  } catch {
    return [];
  }
}

// The last n entries, oldest first, including the rotated file if needed.
export function readRecentErrors(n: number): string[] {
  const { logFile } = paths();
  const lines = readLines(logFile);
  if (lines.length < n) lines.unshift(...readLines(`${logFile}.1`));
  return lines.slice(-n);
}
