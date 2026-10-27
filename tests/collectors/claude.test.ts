import {
  appendFileSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { Database } from 'better-sqlite3';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { claudeCollector, parseClaudeRecord } from '../../src/collectors/claude.ts';
import type { CollectContext, CollectResult } from '../../src/collectors/types.ts';
import { DEFAULT_CONFIG, type Config } from '../../src/core/config.ts';
import { ensureHome, paths } from '../../src/core/paths.ts';
import { makeEvent, type WorkEvent } from '../../src/model/event.ts';
import { openDb } from '../../src/store/db.ts';
import { createRepo } from '../../src/store/repo.ts';

const FIXTURES = resolve(import.meta.dirname, '../fixtures/claude');
const FIXTURE_CWD = '/private/tmp/leftoff-fixture';
const SESSION = 'd36d5788-40d4-4c84-83ef-95b0b001aeb9';

let tmp: string;
let claudeDir: string; // CLAUDE_CONFIG_DIR
let projectDir: string; // where Claude Code keeps this project's transcripts
let db: Database;
let ctx: CollectContext;
const saved = { home: process.env.LEFTOFF_HOME, claude: process.env.CLAUDE_CONFIG_DIR };

beforeEach(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), 'leftoff-claude-')));
  process.env.LEFTOFF_HOME = join(tmp, 'lhome');
  claudeDir = join(tmp, 'claude-config');
  projectDir = join(claudeDir, 'projects', '-private-tmp-leftoff-fixture');
  mkdirSync(projectDir, { recursive: true });
  process.env.CLAUDE_CONFIG_DIR = claudeDir;
  ensureHome();
  db = openDb();
  ctx = {
    repo: createRepo(db),
    config: structuredClone(DEFAULT_CONFIG) as Config,
    now: new Date(),
  };
});

afterEach(() => {
  db.close();
  for (const [key, value] of [
    ['LEFTOFF_HOME', saved.home],
    ['CLAUDE_CONFIG_DIR', saved.claude],
  ] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(tmp, { recursive: true, force: true });
});

function install(fixture: string, name = `${SESSION}.jsonl`): string {
  const file = join(projectDir, name);
  copyFileSync(join(FIXTURES, fixture), file);
  return file;
}

async function collect(): Promise<CollectResult> {
  return claudeCollector.collect(ctx);
}

// What ingest (Task 8) does after a successful collect.
function commit(r: CollectResult): void {
  ctx.repo.insertEvents(r.events);
  for (const c of r.pendingCursors) ctx.repo.setCursor('claude', c.key, c.value);
}

const record = (over: Record<string, unknown>) =>
  JSON.stringify({
    type: 'user',
    isSidechain: false,
    timestamp: '2026-10-26T15:00:00.000Z',
    cwd: FIXTURE_CWD,
    sessionId: 'synthetic',
    uuid: 'u',
    ...over,
  }) + '\n';
const toolUse = (id: string, name: string, input: Record<string, unknown>) =>
  record({
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] },
  });
const toolResult = (id: string, content: string, isError: boolean) =>
  record({
    message: {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: id, content, is_error: isError }],
    },
  });

// Derived by hand from the fixture's records (see tests/fixtures/claude/README.md).
const BASIC_KINDS = [
  'user_prompt', // ls /nope
  'command_failed',
  'agent_message',
  'user_prompt', // Read notes.md
  'tool_error',
  'agent_message',
  'user_prompt', // node --test
  'command_failed',
  'test_failed',
  'agent_message',
  'user_prompt', // fix with Edit
  'file_edit',
  'agent_message',
  'user_prompt', // node --test again
  'command',
  'agent_message',
  'user_prompt', // npm run lint, then one retry
  'command_failed',
  'agent_message',
  'command_failed',
  'agent_message',
  'user_prompt', // "All tests pass, done."
  'agent_message',
];

test('basic session → expected kinds in order', async () => {
  install('session-basic.jsonl');
  const kinds = (await collect()).events.map((e) => e.kind);
  expect(kinds).toEqual(BASIC_KINDS);
});

test('failed Bash tool result is linked to its command', async () => {
  install('session-basic.jsonl');
  const failed = (await collect()).events.find((e) => e.kind === 'command_failed') as WorkEvent;
  expect(failed.summary).toContain('ls /nope');
  expect(failed.summary).toContain('No such file or directory');
  expect(failed.data).toMatchObject({ command: 'ls /nope', exitCode: 1 });
  expect(failed.data.error).toBeDefined();
});

test('commands come from the assistant record, not the rewritten api-request-blob copies', async () => {
  install('session-basic.jsonl');
  const commands = (await collect()).events
    .filter((e) => e.kind === 'command' || e.kind === 'command_failed')
    .map((e) => e.data.command);
  expect(commands).toEqual([
    'ls /nope',
    'node --test 2>&1',
    'node --test 2>&1',
    'npm run lint 2>&1',
    'npx --no-install eslint . 2>&1',
  ]);
});

test('a failing non-Bash tool becomes tool_error; a failing test run also becomes test_failed', async () => {
  install('session-basic.jsonl');
  const events = (await collect()).events;
  const toolError = events.find((e) => e.kind === 'tool_error') as WorkEvent;
  expect(toolError.summary).toMatch(/^Read failed: File does not exist/);
  expect(toolError.data.tool).toBe('Read');
  const testFailed = events.find((e) => e.kind === 'test_failed') as WorkEvent;
  expect(testFailed.summary).toContain('node --test');
});

test('a successful Edit becomes file_edit with the path', async () => {
  install('session-basic.jsonl');
  const edit = (await collect()).events.find((e) => e.kind === 'file_edit') as WorkEvent;
  expect(edit.summary).toBe('Edited calc.js');
  expect(edit.data).toMatchObject({ path: `${FIXTURE_CWD}/calc.js`, tool: 'Edit' });
});

test('prompts, agent messages, timestamps and session id are mapped', async () => {
  install('session-basic.jsonl');
  const events = (await collect()).events;
  const first = events[0] as WorkEvent;
  expect(first).toMatchObject({
    source: 'claude',
    kind: 'user_prompt',
    summary: 'Run ls /nope and tell me what happened.',
    sessionRef: SESSION,
    ts: '2026-10-26T14:18:10.936Z',
  });
  expect(events.at(-1)).toMatchObject({ kind: 'agent_message', summary: 'All tests pass, done.' });
});

test('project root comes from record cwd', async () => {
  install('session-basic.jsonl');
  const roots = new Set((await collect()).events.map((e) => e.projectRoot));
  expect([...roots]).toEqual([realpathOr(FIXTURE_CWD)]);
});

function realpathOr(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

test('malformed and unknown lines are skipped and counted', async () => {
  const file = install('session-malformed.jsonl');
  const r = await collect();
  expect(r.events.map((e) => e.kind)).toEqual(BASIC_KINDS);
  expect(r.warnings).toEqual([`malformed:2:${file}`]);
});

test('partial last line is not consumed, and is read once it is complete', async () => {
  const file = install('session-partial.jsonl');
  const r1 = await collect();
  const offset = Object.values(cursorOffsets(r1))[0] as number;
  expect(offset).toBeLessThan(statSync(file).size);
  commit(r1);
  const full = readFileSync(join(FIXTURES, 'session-basic.jsonl'));
  writeFileSync(file, full); // the writer finishes the line
  const r2 = await collect();
  expect(Object.values(cursorOffsets(r2))).toEqual([full.length]); // now read to the end
  expect(r2.warnings).toEqual([]);
});

function cursorOffsets(r: CollectResult): Record<string, number> {
  return Object.fromEntries(
    r.pendingCursors
      .filter((c) => c.key.endsWith('.jsonl'))
      .map((c) => [c.key, (JSON.parse(c.value) as { offset: number }).offset]),
  );
}

test('re-reading the same file yields no new events (dedupe keys stable)', async () => {
  install('session-basic.jsonl');
  const a = await collect();
  const b = await collect(); // not committed: same events again
  expect(b.events.map((e) => e.dedupeKey)).toEqual(a.events.map((e) => e.dedupeKey));
  commit(a);
  expect((await collect()).events).toEqual([]);
  expect(ctx.repo.insertEvents(a.events)).toBe(0);
});

test('a tool call and its result read in different runs are still linked', async () => {
  const file = join(projectDir, 'split.jsonl');
  writeFileSync(file, toolUse('toolu_1', 'Bash', { command: 'make deploy' }));
  const r1 = await collect();
  expect(r1.events).toEqual([]);
  commit(r1);
  appendFileSync(
    file,
    toolResult('toolu_1', 'Exit code 2\nmake: *** No rule to make target', true),
  );
  const [e] = (await collect()).events;
  expect(e).toMatchObject({
    kind: 'command_failed',
    data: { command: 'make deploy', exitCode: 2 },
  });
});

test('agent messages keep the last 300 characters', async () => {
  const text = 'start ' + 'x'.repeat(400) + ' the conclusion';
  writeFileSync(
    join(projectDir, 'long.jsonl'),
    record({
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'text', text }] },
    }),
  );
  const [e] = (await collect()).events;
  expect(Array.from(e?.summary ?? '')).toHaveLength(300);
  expect(e?.summary.startsWith('…')).toBe(true);
  expect(e?.summary.endsWith(' the conclusion')).toBe(true);
});

test('slash commands, command output and meta records are not user prompts', async () => {
  writeFileSync(
    join(projectDir, 'meta.jsonl'),
    record({ message: { role: 'user', content: '<command-name>/clear</command-name>' } }) +
      record({
        message: { role: 'user', content: '<local-command-stdout>ok</local-command-stdout>' },
      }) +
      record({ isMeta: true, message: { role: 'user', content: 'Caveat: …' } }) +
      record({ message: { role: 'user', content: [{ type: 'text', text: 'a real prompt' }] } }),
  );
  expect((await collect()).events.map((e) => e.summary)).toEqual(['a real prompt']);
});

test('secrets in commands and tool output are redacted', async () => {
  writeFileSync(
    join(projectDir, 'secret.jsonl'),
    toolUse('toolu_s', 'Bash', {
      command: 'export GITHUB_TOKEN=ghp_' + 'a'.repeat(36) + ' && false',
    }) + toolResult('toolu_s', 'Exit code 1\npsql postgres://admin:hunter2@db/x failed', true),
  );
  const [e] = (await collect()).events;
  expect(JSON.stringify(e)).not.toMatch(/ghp_a|hunter2/);
});

test('sessions whose cwd is inside LEFTOFF_HOME are ignored', async () => {
  writeFileSync(
    join(projectDir, 'polish.jsonl'),
    record({ cwd: paths().tmp, message: { role: 'user', content: 'polish these facts' } }),
  );
  expect((await collect()).events).toEqual([]);
});

test('ignore.projects drops a project and everything under it', async () => {
  install('session-basic.jsonl');
  ctx.config.ignore.projects = [realpathOr(FIXTURE_CWD)];
  expect((await collect()).events).toEqual([]);
});

test('CLAUDE_CONFIG_DIR relocates the projects directory', async () => {
  install('session-basic.jsonl');
  process.env.CLAUDE_CONFIG_DIR = join(tmp, 'elsewhere');
  expect((await collect()).events).toEqual([]);
  expect(await claudeCollector.isAvailable(ctx)).toBe(false);
  process.env.CLAUDE_CONFIG_DIR = claudeDir;
  expect((await collect()).events.length).toBeGreaterThan(0);
});

test('first run (no cursors) only considers files modified within retentionDays', async () => {
  const old = install('session-basic.jsonl', 'old.jsonl');
  const longAgo = new Date(Date.now() - 40 * 86_400_000);
  utimesSync(old, longAgo, longAgo);
  expect((await collect()).events).toEqual([]);
});

test('a transcript path reported by a hook event is read even outside the projects folder', async () => {
  const outside = join(tmp, 'elsewhere', 'reported.jsonl');
  mkdirSync(join(tmp, 'elsewhere'));
  copyFileSync(join(FIXTURES, 'session-basic.jsonl'), outside);
  ctx.repo.insertEvents([
    makeEvent({
      source: 'claude',
      kind: 'session_start',
      projectRoot: FIXTURE_CWD,
      ts: new Date().toISOString(),
      sessionRef: SESSION,
      summary: 'Claude Code session started',
      data: { transcriptPath: outside },
      dedupeKey: 'hook-start',
    }),
  ]);
  expect((await collect()).events.some((e) => e.kind === 'command_failed')).toBe(true);
});

test('no projects folder → isAvailable false, no throw', async () => {
  rmSync(join(claudeDir, 'projects'), { recursive: true });
  expect(await claudeCollector.isAvailable(ctx)).toBe(false);
  expect(await collect()).toEqual({ events: [], pendingCursors: expect.any(Array), warnings: [] });
});

test('parseClaudeRecord ignores records that carry no events', () => {
  for (const type of [
    'attachment',
    'mode',
    'api-request-blob',
    'cost-state',
    'future-record-type',
  ]) {
    expect(
      parseClaudeRecord({ type, message: { role: 'assistant', content: [] } }, '/f.jsonl', 10),
    ).toEqual([]);
  }
});

test('api-request-blob copies are never read as work, even with cwd and timestamp', async () => {
  const blob = (content: unknown[]) =>
    record({ type: 'api-request-blob', message: { role: 'assistant', content } });
  writeFileSync(
    join(projectDir, 'blob.jsonl'),
    blob([{ type: 'tool_use', id: 'toolu_b', name: 'Bash', input: { command: 'rm -rf build' } }]) +
      blob([{ type: 'text', text: 'Copied request text' }]) +
      toolResult('toolu_b', 'Exit code 1\nfailed', true),
  );
  const events = (await collect()).events;
  expect(events.map((e) => [e.kind, e.data.command])).toEqual([['tool_error', undefined]]);
});

test('test_failed uses the shared patterns: a failing node run without an AssertionError', async () => {
  writeFileSync(
    join(projectDir, 'timeout.jsonl'),
    toolUse('toolu_t', 'Bash', { command: 'node --test' }) +
      toolResult(
        'toolu_t',
        "Exit code 1\n✖ slow (5000ms)\n  'test timed out after 5000ms'\nℹ fail 1",
        true,
      ),
  );
  expect((await collect()).events.map((e) => e.kind)).toEqual(['command_failed', 'test_failed']);
});
