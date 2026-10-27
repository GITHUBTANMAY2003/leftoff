import { existsSync } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, relative } from 'node:path';
import { dedupeKey, makeEvent, type EventKind, type WorkEvent } from '../model/event.ts';
import { isInsideLeftoffHome, resolveProject } from '../model/project.ts';
import { compileIgnore } from './ignore.ts';
import { readJsonlFrom } from './jsonl-reader.ts';
import { looksLikeTestFailure } from './test-failures.ts';
import type { CollectContext, CollectResult, Collector } from './types.ts';

// Claude Code collector (plan Task 6). Reads session transcripts incrementally.
// Record shapes come from real Claude Code 2.1.310 transcripts; see
// tests/fixtures/claude/README.md. Only `user` and `assistant` records carry
// events: `api-request-blob` records repeat tool calls (same tool-use id,
// rewritten command) and must never be read as work.

const DAY_MS = 86_400_000;
const SCAN_KEY = '__scan'; // cursor: when the projects folder was last scanned
const MAX_PENDING_TOOL_USES = 500;
const MAX_ERROR_CHARS = 1000;
const AGENT_MESSAGE_CHARS = 300;
const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const NOT_A_PROMPT = /^<(command-|local-command|system-reminder)/;

// $CLAUDE_CONFIG_DIR if set, else ~/.claude (R-C6).
export function claudeDir(): string {
  return process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude');
}

// A tool call waiting for its result. The result doesn't repeat the command,
// so calls are remembered (in the file's cursor) until their result arrives.
export interface PendingTool {
  name: string;
  command?: string;
  path?: string;
}

interface FileCursor {
  offset: number;
  toolUses: Record<string, PendingTool>;
}

type Draft = { kind: EventKind; summary: string; data: Record<string, unknown> };

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter((b) => isObject(b) && b.type === 'text' && typeof b.text === 'string')
      .map((b) => (b as { text: string }).text)
      .join('\n');
  }
  return '';
}

const firstLine = (text: string) =>
  text
    .split('\n')
    .find((l) => l.trim() !== '')
    ?.trim() ?? '';

function lastChars(text: string, max: number): string {
  const chars = Array.from(text);
  return chars.length <= max ? text : '…' + chars.slice(-(max - 1)).join('');
}

function resultDrafts(
  block: Record<string, unknown>,
  tools: Map<string, PendingTool>,
  root: string,
): Draft[] {
  const id = String(block.tool_use_id ?? '');
  const tool = tools.get(id);
  tools.delete(id);
  const isError = block.is_error === true;
  const output = textOf(block.content);
  if (tool?.name === 'Bash' && tool.command !== undefined) {
    const exit = /^Exit code (\d+)/.exec(output);
    const exitCode = exit ? Number(exit[1]) : isError ? 1 : 0;
    const command = tool.command;
    if (!isError) return [{ kind: 'command', summary: command, data: { command, exitCode } }];
    const error = (exit ? output.slice(exit[0].length) : output).trim();
    const drafts: Draft[] = [
      {
        kind: 'command_failed',
        summary: `\`${command}\` failed: ${firstLine(error)}`,
        data: { command, exitCode, error: error.slice(0, MAX_ERROR_CHARS) },
      },
    ];
    if (looksLikeTestFailure(output)) {
      drafts.push({
        kind: 'test_failed',
        summary: `Tests failed: \`${command}\``,
        data: { command, output: error.slice(0, MAX_ERROR_CHARS) },
      });
    }
    return drafts;
  }
  if (tool && EDIT_TOOLS.has(tool.name) && !isError && tool.path) {
    const rel =
      isAbsolute(tool.path) && tool.path.startsWith(root + '/')
        ? relative(root, tool.path)
        : tool.path;
    const verb = tool.name === 'Write' ? 'Wrote' : 'Edited';
    return [
      { kind: 'file_edit', summary: `${verb} ${rel}`, data: { path: tool.path, tool: tool.name } },
    ];
  }
  if (!isError) return [];
  const name = tool?.name ?? 'A tool';
  return [
    {
      kind: 'tool_error',
      summary: `${name} failed: ${firstLine(output)}`,
      data: { tool: tool?.name ?? null, error: output.slice(0, MAX_ERROR_CHARS) },
    },
  ];
}

// Turns one transcript record into events. `tools` carries tool calls between
// records (and between runs, via the cursor). Unknown record types, block
// types and fields are ignored.
export function parseClaudeRecord(
  rec: unknown,
  file: string,
  endOffset: number,
  tools: Map<string, PendingTool> = new Map(),
): WorkEvent[] {
  if (!isObject(rec) || (rec.type !== 'user' && rec.type !== 'assistant') || rec.isMeta === true)
    return [];
  const message = rec.message;
  if (!isObject(message) || typeof rec.cwd !== 'string' || typeof rec.timestamp !== 'string')
    return [];
  const ts = new Date(rec.timestamp);
  if (Number.isNaN(ts.getTime())) return [];
  const root = resolveProject(rec.cwd);
  const drafts: Draft[] = [];
  const blocks = Array.isArray(message.content) ? message.content.filter(isObject) : [];

  if (rec.type === 'user') {
    for (const block of blocks.filter((b) => b.type === 'tool_result'))
      drafts.push(...resultDrafts(block, tools, root));
    const prompt = textOf(message.content).trim();
    if (prompt !== '' && !NOT_A_PROMPT.test(prompt))
      drafts.unshift({ kind: 'user_prompt', summary: prompt, data: {} });
  } else {
    for (const block of blocks) {
      if (block.type === 'text' && typeof block.text === 'string' && block.text.trim() !== '') {
        drafts.push({
          kind: 'agent_message',
          summary: lastChars(block.text.trim(), AGENT_MESSAGE_CHARS),
          data: {},
        });
      } else if (
        block.type === 'tool_use' &&
        typeof block.id === 'string' &&
        typeof block.name === 'string'
      ) {
        const input = isObject(block.input) ? block.input : {};
        const path = input.file_path ?? input.notebook_path;
        tools.set(block.id, {
          name: block.name,
          ...(typeof input.command === 'string' ? { command: input.command } : {}),
          ...(typeof path === 'string' ? { path } : {}),
        });
        while (tools.size > MAX_PENDING_TOOL_USES)
          tools.delete(tools.keys().next().value as string);
      }
    }
  }

  return drafts.map((d, index) =>
    makeEvent({
      source: 'claude',
      kind: d.kind,
      projectRoot: root,
      ts: ts.toISOString(),
      sessionRef: typeof rec.sessionId === 'string' ? rec.sessionId : null,
      summary: d.summary,
      data: d.data,
      dedupeKey: dedupeKey('claude', file, endOffset, index),
    }),
  );
}

function readCursor(value: string | null): FileCursor {
  try {
    const c = JSON.parse(value ?? '') as Partial<FileCursor>;
    return {
      offset: typeof c.offset === 'number' && c.offset >= 0 ? c.offset : 0,
      toolUses: isObject(c.toolUses) ? (c.toolUses as Record<string, PendingTool>) : {},
    };
  } catch {
    return { offset: 0, toolUses: {} };
  }
}

async function listTranscripts(dir: string): Promise<string[]> {
  if (!existsSync(dir)) return [];
  const entries = await readdir(dir, { recursive: true });
  return entries.filter((e) => e.endsWith('.jsonl')).map((e) => join(dir, e));
}

export const claudeCollector: Collector = {
  name: 'claude',

  async isAvailable() {
    return existsSync(join(claudeDir(), 'projects'));
  },

  async collect(ctx: CollectContext): Promise<CollectResult> {
    const result: CollectResult = { events: [], pendingCursors: [], warnings: [] };
    const ignore = compileIgnore(ctx.config);

    // Which files: recently modified transcripts, plus any path a hook reported.
    // First run: the last retentionDays (R-D4); later: since the last scan, minus a day.
    const lastScan = ctx.repo.getCursor('claude', SCAN_KEY);
    const since = lastScan
      ? Date.parse(lastScan) - DAY_MS
      : ctx.now.getTime() - ctx.config.retentionDays * DAY_MS;
    const files = new Set<string>();
    for (const file of await listTranscripts(join(claudeDir(), 'projects'))) {
      if ((await stat(file)).mtimeMs >= since) files.add(file);
    }
    for (const e of ctx.repo.eventsSince(new Date(since).toISOString())) {
      if (e.source === 'claude' && typeof e.data.transcriptPath === 'string')
        files.add(e.data.transcriptPath);
    }

    for (const file of files) {
      const cursor = readCursor(ctx.repo.getCursor('claude', file));
      let size: number;
      try {
        size = (await stat(file)).size;
      } catch {
        continue; // reported by a hook but gone, or deleted meanwhile
      }
      const restarted = size < cursor.offset; // rewritten: pending tool calls are void
      const tools = new Map(restarted ? [] : Object.entries(cursor.toolUses));
      const read = await readJsonlFrom(
        file,
        cursor.offset,
        ctx.config.ingest.maxBytesPerFilePerRun,
      );
      for (const { value, endOffset } of read.records) {
        for (const event of parseClaudeRecord(value, file, endOffset, tools)) {
          if (isInsideLeftoffHome(event.projectRoot)) continue; // recursion guard (§1.9)
          if (ignore.isIgnoredProject(event.projectRoot)) continue;
          result.events.push(event);
        }
      }
      if (read.malformed > 0) result.warnings.push(`malformed:${read.malformed}:${file}`);
      const next: FileCursor = { offset: read.nextOffset, toolUses: Object.fromEntries(tools) };
      result.pendingCursors.push({ key: file, value: JSON.stringify(next) });
    }
    result.pendingCursors.push({ key: SCAN_KEY, value: ctx.now.toISOString() });
    return result;
  },
};
