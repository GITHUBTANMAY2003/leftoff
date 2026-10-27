import { existsSync } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dedupeKey, makeEvent, type EventKind, type WorkEvent } from '../model/event.ts';
import { isInsideLeftoffHome, resolveProject } from '../model/project.ts';
import { compileIgnore } from './ignore.ts';
import { readJsonlFrom, readZstJsonl } from './jsonl-reader.ts';
import { isProbeFailure } from './probes.ts';
import { looksLikeTestFailure } from './test-failures.ts';
import { pastDeadline, type CollectContext, type CollectResult, type Collector } from './types.ts';

// Codex CLI collector (plan Task 7). Record shapes come from a real codex-cli
// 0.163.0 session; see tests/fixtures/codex/README.md. Events come only from
// `event_msg` records of type `item_completed`: the `response_item` records
// repeat the same messages and tool calls (as JavaScript snippets) and are
// ignored. Older sessions are rewritten by Codex as .jsonl.zst; dedupe keys use
// the thread id and the record's `ordinal`, so a session read once as .jsonl
// and again as .jsonl.zst produces the same keys.

const DAY_MS = 86_400_000;
const MB = 1024 * 1024;
const SCAN_KEY = '__scan';
const MAX_ERROR_CHARS = 1000;
const AGENT_MESSAGE_CHARS = 300;
const ROLLOUT = /^rollout-.*\.jsonl(\.zst)?$/;
const CHANGE_VERBS: Record<string, string> = { update: 'Edited', add: 'Added', delete: 'Deleted' };

// $CODEX_HOME if set, else ~/.codex (R-C6).
export function codexDir(): string {
  return process.env.CODEX_HOME || join(homedir(), '.codex');
}

// Carried from record to record, and between runs in the file's cursor.
export interface CodexState {
  cwd?: string | null;
  threadId?: string | null;
}

type Draft = { kind: EventKind; summary: string; data: Record<string, unknown> };

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const firstLine = (text: string) =>
  text
    .split('\n')
    .find((l) => l.trim() !== '')
    ?.trim() ?? '';

function lastChars(text: string, max: number): string {
  const chars = Array.from(text);
  return chars.length <= max ? text : '…' + chars.slice(-(max - 1)).join('');
}

function texts(content: unknown): string {
  if (!Array.isArray(content)) return '';
  return content
    .filter((c) => isObject(c) && typeof c.text === 'string')
    .map((c) => (c as { text: string }).text)
    .join('\n')
    .trim();
}

// ["/bin/zsh", "-lc", "ls /nope"] → "ls /nope"
function commandText(command: unknown): string {
  if (typeof command === 'string') return command;
  if (!Array.isArray(command)) return '';
  const parts = command.map(String);
  return parts.length >= 3 && /^-l?c$/.test(parts[1] ?? '')
    ? (parts[2] as string)
    : parts.join(' ');
}

function cwdOf(item: Record<string, unknown>, state: CodexState): string | null {
  if (typeof item.cwd === 'string') {
    try {
      return item.cwd.startsWith('file:') ? fileURLToPath(item.cwd) : item.cwd;
    } catch {
      // fall through to the session's cwd
    }
  }
  return state.cwd ?? null;
}

function itemDrafts(item: Record<string, unknown>, root: string): Draft[] {
  switch (item.type) {
    case 'UserMessage': {
      const text = texts(item.content);
      return text === '' || text.startsWith('<')
        ? []
        : [{ kind: 'user_prompt', summary: text, data: {} }];
    }
    case 'AgentMessage': {
      const text = texts(item.content);
      if (text === '') return [];
      const phase = typeof item.phase === 'string' ? item.phase : null;
      return [
        { kind: 'agent_message', summary: lastChars(text, AGENT_MESSAGE_CHARS), data: { phase } },
      ];
    }
    case 'CommandExecution': {
      const command = commandText(item.command);
      if (command === '') return [];
      const exitCode =
        typeof item.exit_code === 'number' ? item.exit_code : item.status === 'failed' ? 1 : 0;
      const output = typeof item.aggregated_output === 'string' ? item.aggregated_output : '';
      if (item.status !== 'failed' && exitCode === 0) {
        return [{ kind: 'command', summary: command, data: { command, exitCode } }];
      }
      const drafts: Draft[] = [
        {
          kind: 'command_failed',
          summary: `\`${command}\` failed: ${firstLine(output) || `exit code ${exitCode}`}`,
          data: {
            command,
            exitCode,
            error: output.trim().slice(0, MAX_ERROR_CHARS),
            ...(isProbeFailure(command, exitCode, output) ? { probe: true } : {}),
          },
        },
      ];
      if (looksLikeTestFailure(output)) {
        drafts.push({
          kind: 'test_failed',
          summary: `Tests failed: \`${command}\``,
          data: { command, output: output.trim().slice(0, MAX_ERROR_CHARS) },
        });
      }
      return drafts;
    }
    case 'FileChange': {
      const changes = isObject(item.changes) ? Object.entries(item.changes) : [];
      if (item.status !== 'completed') {
        const paths = changes.map(([p]) => p);
        return [
          {
            kind: 'tool_error',
            summary: `Patch failed: ${paths.join(', ')}`,
            data: { tool: 'apply_patch', paths },
          },
        ];
      }
      return changes.map(([path, change]) => {
        const type = isObject(change) && typeof change.type === 'string' ? change.type : 'update';
        const rel = path.startsWith(root + '/') ? relative(root, path) : path;
        return {
          kind: 'file_edit' as const,
          summary: `${CHANGE_VERBS[type] ?? 'Changed'} ${rel}`,
          data: { path, change: type },
        };
      });
    }
    default:
      return []; // Reasoning, and item types this version doesn't know
  }
}

// Turns one session record into events, updating `state` (session cwd and id).
export function parseCodexRecord(rec: unknown, state: CodexState): WorkEvent[] {
  if (!isObject(rec) || !isObject(rec.payload)) return [];
  const payload = rec.payload;
  if (rec.type === 'session_meta' || rec.type === 'turn_context') {
    if (typeof payload.cwd === 'string') state.cwd = payload.cwd;
    if (rec.type === 'session_meta' && typeof payload.id === 'string') state.threadId = payload.id;
    return [];
  }
  if (rec.type !== 'event_msg' || payload.type !== 'item_completed' || !isObject(payload.item))
    return [];
  const ts = new Date(String(rec.timestamp));
  if (Number.isNaN(ts.getTime())) return [];
  const item = payload.item;
  const cwd = cwdOf(item, state);
  if (cwd === null) return [];
  const root = resolveProject(cwd);
  const threadId =
    typeof payload.thread_id === 'string' ? payload.thread_id : (state.threadId ?? null);
  const position =
    typeof rec.ordinal === 'number' ? rec.ordinal : `${ts.toISOString()}:${String(item.id)}`;
  return itemDrafts(item, root).map((d, index) =>
    makeEvent({
      source: 'codex',
      kind: d.kind,
      projectRoot: root,
      ts: ts.toISOString(),
      sessionRef: threadId,
      summary: d.summary,
      data: d.data,
      dedupeKey: dedupeKey('codex', threadId ?? '', position, index),
    }),
  );
}

interface PlainCursor extends CodexState {
  offset: number;
  readAt?: string;
}
// size/mtimeMs are -1 while a file is only partly read (soft deadline).
interface ZstCursor extends CodexState {
  size: number;
  mtimeMs: number;
  lines: number;
  readAt?: string;
}

function readCursor<T extends object>(value: string | null): Partial<T> {
  try {
    const parsed: unknown = JSON.parse(value ?? '');
    return isObject(parsed) ? (parsed as Partial<T>) : {};
  } catch {
    return {};
  }
}

async function listRollouts(dir: string): Promise<string[]> {
  if (!existsSync(dir)) return [];
  const entries = await readdir(dir, { recursive: true });
  return entries.filter((e) => ROLLOUT.test(e.split('/').at(-1) ?? '')).map((e) => join(dir, e));
}

export const codexCollector: Collector = {
  name: 'codex',

  async isAvailable() {
    return existsSync(join(codexDir(), 'sessions'));
  },

  async collect(ctx: CollectContext): Promise<CollectResult> {
    const result: CollectResult = { events: [], pendingCursors: [], warnings: [] };
    const ignore = compileIgnore(ctx.config);
    const lastScan = ctx.repo.getCursor('codex', SCAN_KEY);
    const since = lastScan
      ? Date.parse(lastScan) - DAY_MS
      : ctx.now.getTime() - ctx.config.retentionDays * DAY_MS;

    const keep = (events: WorkEvent[]) => {
      for (const e of events) {
        if (isInsideLeftoffHome(e.projectRoot)) continue; // recursion guard (§1.9)
        if (ignore.isIgnoredProject(e.projectRoot)) continue;
        result.events.push(e);
      }
    };

    // Least recently read first, so a soft deadline rotates through a backlog.
    const readAt = (file: string) =>
      String(readCursor<{ readAt: string }>(ctx.repo.getCursor('codex', file)).readAt ?? '');
    const queue = (await listRollouts(join(codexDir(), 'sessions')))
      .map((file) => ({ file, at: readAt(file) }))
      .sort((a, b) => a.at.localeCompare(b.at))
      .map((q) => q.file);
    let didWork = false;
    for (const file of queue) {
      let info: { size: number; mtimeMs: number };
      try {
        info = await stat(file);
      } catch {
        continue;
      }
      if (info.mtimeMs < since) continue;

      if (file.endsWith('.zst')) {
        const cursor = readCursor<ZstCursor>(ctx.repo.getCursor('codex', file));
        if (cursor.size === info.size && cursor.mtimeMs === info.mtimeMs) continue;
        if (didWork && pastDeadline(ctx)) break; // soft deadline: keep what's done
        didWork = true;
        if (info.size > ctx.config.codex.maxCompressedMb * MB) {
          result.warnings.push(
            `too large, skipped: ${file} (${(info.size / MB).toFixed(1)} MB > codex.maxCompressedMb ${ctx.config.codex.maxCompressedMb})`,
          );
          continue;
        }
        const state: CodexState = { cwd: cursor.cwd ?? null, threadId: cursor.threadId ?? null };
        const read = await readZstJsonl(file, cursor.lines ?? 0, ctx.deadline);
        for (const rec of read.records) keep(parseCodexRecord(rec, state));
        if (read.malformed > 0) result.warnings.push(`malformed:${read.malformed}:${file}`);
        const next: ZstCursor = {
          size: read.complete ? info.size : -1,
          mtimeMs: read.complete ? info.mtimeMs : -1,
          lines: read.totalLines,
          readAt: new Date().toISOString(),
          ...state,
        };
        result.pendingCursors.push({ key: file, value: JSON.stringify(next) });
      } else {
        const cursor = readCursor<PlainCursor>(ctx.repo.getCursor('codex', file));
        const offset =
          typeof cursor.offset === 'number' && cursor.offset <= info.size ? cursor.offset : 0;
        if (offset === info.size) continue; // nothing new
        if (didWork && pastDeadline(ctx)) break; // soft deadline: keep what's done
        didWork = true;
        const state: CodexState =
          offset > 0 ? { cwd: cursor.cwd ?? null, threadId: cursor.threadId ?? null } : {};
        const read = await readJsonlFrom(
          file,
          offset,
          ctx.config.ingest.maxBytesPerFilePerRun,
          ctx.deadline,
        );
        for (const { value } of read.records) keep(parseCodexRecord(value, state));
        if (read.malformed > 0) result.warnings.push(`malformed:${read.malformed}:${file}`);
        const next: PlainCursor = {
          offset: read.nextOffset,
          cwd: state.cwd ?? null,
          threadId: state.threadId ?? null,
          readAt: new Date().toISOString(),
        };
        result.pendingCursors.push({ key: file, value: JSON.stringify(next) });
      }
    }
    result.pendingCursors.push({ key: SCAN_KEY, value: ctx.now.toISOString() });
    return result;
  },
};
