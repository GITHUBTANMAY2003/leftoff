import {
  closeSync,
  existsSync,
  openSync,
  readdirSync,
  readSync,
  renameSync,
  statSync,
  unlinkSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import type { Config } from '../core/config.ts';
import { paths } from '../core/paths.ts';
import { dedupeKey, makeEvent, normalizeCommand, type WorkEvent } from '../model/event.ts';
import { isInsideLeftoffHome, resolveProject } from '../model/project.ts';
import type { CollectContext, CollectResult, Collector } from './types.ts';

// Reads the lines the shell hooks append to shell.log (plan Task 4):
//   ts_epoch_ms \t exit_code \t duration_ms \t pid \t cwd \t command
//
// shell.log is never rewritten in place (R-B6). Each run first renames it to
// shell.log.<ms>.<pid>.ingesting, so shells keep appending to a fresh file and
// no line is lost. afterCommit deletes a renamed file once every byte of it
// has been committed; until then it is read again from the cursor, so a line a
// shell finished writing after the rename is still picked up.

const CURSOR_KEY = 'ingesting'; // value: JSON { [file name]: committed byte offset }
const INGESTING = /^shell\.log\.[\w.-]+\.ingesting$/;
const ABANDONED_MS = 60_000; // a partial last line untouched this long will never be finished
const NEWLINE = 0x0a;

interface Filters {
  projects: RegExp[];
  commands: RegExp[];
}

function globToRegExp(glob: string, pathMode: boolean): RegExp {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i] as string;
    if (c === '*' && glob[i + 1] === '*') {
      re += '.*';
      i++;
    } else if (c === '*') {
      re += pathMode ? '[^/]*' : '.*';
    } else if (c === '?') {
      re += pathMode ? '[^/]' : '.';
    } else {
      re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(`^${re}$`);
}

function compileFilters(config: Config): Filters {
  const expand = (g: string) => (g === '~' || g.startsWith('~/') ? homedir() + g.slice(1) : g);
  return {
    projects: config.ignore.projects.map((g) => globToRegExp(resolve(expand(g)), true)),
    commands: config.ignore.commands.map((g) => globToRegExp(g, false)),
  };
}

// A folder is ignored when it or any folder above it matches a glob, so
// ignoring ~/secret also ignores ~/secret/app/src.
function isIgnoredDir(cwd: string, globs: RegExp[]): boolean {
  if (globs.length === 0) return false;
  for (let dir = cwd; ; dir = dirname(dir)) {
    if (globs.some((g) => g.test(dir))) return true;
    if (dirname(dir) === dir) return false;
  }
}

interface ParsedLine {
  tsMs: number;
  exitCode: number;
  durationMs: number | null;
  pid: string;
  cwd: string;
  command: string;
}

function parseLine(line: string): ParsedLine | null {
  const [ts, exit, duration, pid, cwd, ...rest] = line.split('\t');
  const command = rest.join('\t');
  if (
    !/^\d+$/.test(ts ?? '') ||
    !/^\d+$/.test(exit ?? '') ||
    !/^-?\d+$/.test(duration ?? '') ||
    !/^\d+$/.test(pid ?? '') ||
    !cwd?.startsWith('/') ||
    command === ''
  ) {
    return null;
  }
  return {
    tsMs: Number(ts),
    exitCode: Number(exit),
    durationMs: Number(duration) < 0 ? null : Number(duration),
    pid: pid as string,
    cwd,
    command,
  };
}

function toEvent(raw: string, p: ParsedLine): WorkEvent {
  const failed = p.exitCode !== 0;
  return makeEvent({
    source: 'shell',
    kind: failed ? 'command_failed' : 'command',
    projectRoot: resolveProject(p.cwd),
    ts: new Date(p.tsMs).toISOString(),
    sessionRef: `shell:${p.pid}`,
    summary: failed ? `\`${p.command}\` exited ${p.exitCode}` : p.command,
    data: { exitCode: p.exitCode, durationMs: p.durationMs, cwd: p.cwd },
    // The line itself: stable however often the file is renamed or re-read.
    dedupeKey: dedupeKey('shell', raw),
  });
}

function readOffsets(value: string | null): Record<string, number> {
  try {
    const parsed: unknown = JSON.parse(value ?? '{}');
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, number>) : {};
  } catch {
    return {};
  }
}

// Reads complete lines from `offset`, at most maxBytes. Returns the new offset.
function readChunk(
  file: string,
  offset: number,
  maxBytes: number,
): { text: string; next: number; size: number; mtimeMs: number; reachedEnd: boolean } {
  const { size, mtimeMs } = statSync(file);
  const start = offset <= size ? offset : 0;
  const length = Math.min(size - start, maxBytes);
  const buf = Buffer.alloc(length);
  const fd = openSync(file, 'r');
  try {
    readSync(fd, buf, 0, length, start);
  } finally {
    closeSync(fd);
  }
  const end = buf.lastIndexOf(NEWLINE) + 1; // 0 when there is no complete line
  return {
    text: buf.subarray(0, end).toString('utf8'),
    next: start + end,
    size,
    mtimeMs,
    reachedEnd: start + length === size,
  };
}

function listIngesting(shellDir: string): string[] {
  return readdirSync(shellDir)
    .filter((f) => INGESTING.test(f))
    .sort();
}

export const shellCollector: Collector = {
  name: 'shell',

  async isAvailable() {
    return existsSync(paths().shellDir);
  },

  async collect(ctx: CollectContext): Promise<CollectResult> {
    const result: CollectResult = { events: [], pendingCursors: [], warnings: [] };
    const { shellDir, shellLog } = paths();
    if (!existsSync(shellDir)) return result;

    // Leftovers from earlier runs first (crash, uncommitted, late bytes), then the live log.
    const files = listIngesting(shellDir);
    if (existsSync(shellLog) && statSync(shellLog).size > 0) {
      const name = `shell.log.${Date.now()}.${process.pid}.ingesting`;
      renameSync(shellLog, join(shellDir, name));
      files.push(name);
    }
    if (files.length === 0) return result;

    const committed = readOffsets(ctx.repo.getCursor('shell', CURSOR_KEY));
    const filters = compileFilters(ctx.config);
    const next: Record<string, number> = {};
    for (const name of files) {
      const file = join(shellDir, name);
      const chunk = readChunk(file, committed[name] ?? 0, ctx.config.ingest.maxBytesPerFilePerRun);
      let malformed = 0;
      for (const raw of chunk.text.split('\n')) {
        if (raw === '') continue;
        const parsed = parseLine(raw);
        if (!parsed) {
          malformed++;
          continue;
        }
        if (parsed.command.startsWith(' ')) continue; // the hooks skip these; belt and braces
        if (isInsideLeftoffHome(parsed.cwd)) continue; // recursion guard (§1.9)
        if (isIgnoredDir(parsed.cwd, filters.projects)) continue;
        const normalized = normalizeCommand(parsed.command);
        if (filters.commands.some((g) => g.test(normalized))) continue;
        result.events.push(toEvent(raw, parsed));
      }
      let offset = chunk.next;
      const leftover = chunk.size - chunk.next;
      if (chunk.reachedEnd && leftover > 0 && Date.now() - chunk.mtimeMs > ABANDONED_MS) {
        malformed++; // a cut-off last line nobody is still writing
        offset = chunk.size;
      } else if (!chunk.reachedEnd && chunk.text === '') {
        malformed++; // one "line" longer than maxBytes: skip it rather than stall forever
        offset = chunk.next + ctx.config.ingest.maxBytesPerFilePerRun;
      }
      if (malformed > 0) result.warnings.push(`malformed:${malformed}:${file}`);
      next[name] = offset;
    }
    result.pendingCursors.push({ key: CURSOR_KEY, value: JSON.stringify(next) });
    return result;
  },

  async afterCommit(ctx: CollectContext): Promise<void> {
    const { shellDir } = paths();
    for (const [name, offset] of Object.entries(
      readOffsets(ctx.repo.getCursor('shell', CURSOR_KEY)),
    )) {
      const file = join(shellDir, name);
      try {
        if (statSync(file).size === offset) unlinkSync(file);
      } catch {
        // Already deleted by a concurrent ingest.
      }
    }
  },
};
