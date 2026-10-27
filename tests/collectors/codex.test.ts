import { execFileSync } from 'node:child_process';
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
import { zstdCompressSync } from 'node:zlib';
import { join, resolve } from 'node:path';
import type { Database } from 'better-sqlite3';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { codexCollector, parseCodexRecord } from '../../src/collectors/codex.ts';
import type { CollectContext, CollectResult } from '../../src/collectors/types.ts';
import { DEFAULT_CONFIG, type Config } from '../../src/core/config.ts';
import { ensureHome, paths } from '../../src/core/paths.ts';
import type { WorkEvent } from '../../src/model/event.ts';
import { openDb } from '../../src/store/db.ts';
import { createRepo } from '../../src/store/repo.ts';

const FIXTURES = resolve(import.meta.dirname, '../fixtures/codex');
const FIXTURE_CWD = '/private/tmp/leftoff-codex-fixture';
const THREAD = '01a178ac-c430-7a40-878e-9b9ae07e45c4';
const ROLLOUT = `rollout-2026-10-26T20-15-50-${THREAD}.jsonl`;

let tmp: string;
let codexHome: string;
let dayDir: string;
let db: Database;
let ctx: CollectContext;
const saved = { home: process.env.LEFTOFF_HOME, codex: process.env.CODEX_HOME };

beforeEach(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), 'leftoff-codex-')));
  process.env.LEFTOFF_HOME = join(tmp, 'lhome');
  codexHome = join(tmp, 'codex-home');
  dayDir = join(codexHome, 'sessions', '2026', '10', '26');
  mkdirSync(dayDir, { recursive: true });
  process.env.CODEX_HOME = codexHome;
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
    ['CODEX_HOME', saved.codex],
  ] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(tmp, { recursive: true, force: true });
});

function install(fixture: string, name = ROLLOUT): string {
  const file = join(dayDir, name);
  copyFileSync(join(FIXTURES, fixture), file);
  return file;
}

const collect = () => codexCollector.collect(ctx);

// What ingest (Task 8) does after a successful collect; returns rows inserted.
function commit(r: CollectResult): number {
  const inserted = ctx.repo.insertEvents(r.events);
  for (const c of r.pendingCursors) ctx.repo.setCursor('codex', c.key, c.value);
  return inserted;
}

function realpathOr(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

// Derived by hand from the fixture's item_completed records (see tests/fixtures/codex/README.md).
const BASIC_KINDS = [
  'user_prompt', // ls /nope
  'agent_message',
  'command_failed',
  'agent_message',
  'user_prompt', // notes.md: rg (exit 1), then ls -la
  'agent_message',
  'command_failed',
  'agent_message',
  'command',
  'agent_message',
  'user_prompt', // node --test
  'agent_message',
  'command_failed',
  'test_failed',
  'agent_message',
  'user_prompt', // fix: cat, then apply_patch
  'agent_message',
  'command',
  'agent_message',
  'file_edit',
  'agent_message',
  'user_prompt', // node --test again
  'agent_message',
  'command',
  'agent_message',
  'user_prompt', // npm run lint, then npx (interrupted, exit 130)
  'agent_message',
  'command_failed',
  'agent_message',
  'command_failed',
  'agent_message',
  'user_prompt', // "All tests pass, done."
  'agent_message',
];

test('plain rollout → same kinds as the claude scenario', async () => {
  install('session-basic.jsonl');
  expect((await collect()).events.map((e) => e.kind)).toEqual(BASIC_KINDS);
});

test('commands come from item_completed, not the repeated response_item tool calls', async () => {
  install('session-basic.jsonl');
  const commands = (await collect()).events
    .filter((e) => e.kind === 'command' || e.kind === 'command_failed')
    .map((e) => [e.data.command, e.data.exitCode]);
  expect(commands).toEqual([
    ['ls /nope', 1],
    ["rg --files -g 'notes.md' -g 'NOTES.md' -g 'Notes.md'", 1],
    ['ls -la', 0],
    ['node --test', 1],
    ['cat calc.js && cat calc.test.js', 0],
    ['node --test', 0],
    ['npm run lint', 1],
    ['npx --no-install eslint .', 130],
  ]);
});

test('a failed command carries its first error line; a failing test run is also test_failed', async () => {
  install('session-basic.jsonl');
  const events = (await collect()).events;
  const failed = events.find((e) => e.kind === 'command_failed') as WorkEvent;
  expect(failed.summary).toBe('`ls /nope` failed: ls: /nope: No such file or directory');
  expect(failed.data.error).toContain('No such file or directory');
  expect(events.find((e) => e.kind === 'test_failed')?.summary).toBe('Tests failed: `node --test`');
});

test('a FileChange becomes file_edit with the path', async () => {
  install('session-basic.jsonl');
  const edit = (await collect()).events.find((e) => e.kind === 'file_edit') as WorkEvent;
  expect(edit.summary).toBe('Edited calc.js');
  expect(edit.data).toMatchObject({ path: `${FIXTURE_CWD}/calc.js`, change: 'update' });
});

test('project root from session metadata cwd; session id and timestamps', async () => {
  install('session-basic.jsonl');
  const events = (await collect()).events;
  expect(new Set(events.map((e) => e.projectRoot))).toEqual(new Set([realpathOr(FIXTURE_CWD)]));
  expect(new Set(events.map((e) => e.sessionRef))).toEqual(new Set([THREAD]));
  expect(events[0]).toMatchObject({
    kind: 'user_prompt',
    summary: 'Run ls /nope and tell me what happened.',
    ts: '2026-10-26T14:47:14.622Z', // the item_completed record's own timestamp
  });
  expect(events.at(-1)?.summary).toBe('All tests pass, done.');
});

test('zst file read fully once, skipped when size+mtime unchanged', async () => {
  install('session-basic.jsonl.zst', ROLLOUT + '.zst');
  const first = await collect();
  expect(first.events.map((e) => e.kind)).toEqual(BASIC_KINDS);
  commit(first);
  const again = await collect();
  expect(again.events).toEqual([]);
  // Not even opened: no cursor is rewritten for an unchanged compressed file.
  expect(again.pendingCursors.map((c) => c.key)).toEqual(['__scan']);
});

test('a session that is compressed between runs (.jsonl → .jsonl.zst) adds no duplicates', async () => {
  const plain = install('session-basic.jsonl');
  const first = await collect();
  expect(commit(first)).toBe(BASIC_KINDS.length);
  // Codex compresses the session later and removes the plain file.
  rmSync(plain);
  install('session-basic.jsonl.zst', ROLLOUT + '.zst');
  const second = await collect();
  expect(second.events.map((e) => e.dedupeKey).sort()).toEqual(
    first.events.map((e) => e.dedupeKey).sort(),
  );
  expect(commit(second)).toBe(0);
});

test('zst file above codex.maxCompressedMb is skipped with a warning', async () => {
  const file = install('session-basic.jsonl.zst', ROLLOUT + '.zst');
  ctx.config.codex.maxCompressedMb = 0;
  const r = await collect();
  expect(r.events).toEqual([]);
  expect(r.warnings).toEqual([expect.stringMatching(new RegExp(`too large.*${file}`))]);
});

test('missing ~/.codex → isAvailable false, no throw', async () => {
  rmSync(codexHome, { recursive: true });
  expect(await codexCollector.isAvailable(ctx)).toBe(false);
  expect((await collect()).events).toEqual([]);
});

test('CODEX_HOME relocates the sessions directory', async () => {
  install('session-basic.jsonl');
  process.env.CODEX_HOME = join(tmp, 'elsewhere');
  expect((await collect()).events).toEqual([]);
  process.env.CODEX_HOME = codexHome;
  expect((await collect()).events.length).toBe(BASIC_KINDS.length);
});

test('unknown record types ignored; malformed lines counted', async () => {
  const file = install('session-malformed.jsonl');
  const r = await collect();
  expect(r.events.map((e) => e.kind)).toEqual(BASIC_KINDS);
  expect(r.warnings).toEqual([`malformed:2:${file}`]);
});

test('partial last line is not consumed', async () => {
  const file = install('session-partial.jsonl');
  const r = await collect();
  const cursor = JSON.parse(r.pendingCursors.find((c) => c.key === file)?.value ?? '{}');
  expect(cursor.offset).toBeLessThan(statSync(file).size);
});

test('the session cwd is remembered between runs', async () => {
  const lines = readFileSync(join(FIXTURES, 'session-basic.jsonl'), 'utf8').split('\n');
  const file = join(dayDir, ROLLOUT);
  // Run 1 ends right after the first turn_context; run 2 starts with that turn's
  // UserMessage, whose cwd is known only from run 1.
  writeFileSync(file, lines.slice(0, 4).join('\n') + '\n');
  commit(await collect());
  appendFileSync(file, lines.slice(4).join('\n'));
  const events = (await collect()).events;
  expect(events.length).toBe(BASIC_KINDS.length);
  expect(new Set(events.map((e) => e.projectRoot))).toEqual(new Set([realpathOr(FIXTURE_CWD)]));
});

test('first run only considers sessions modified within retentionDays', async () => {
  const file = install('session-basic.jsonl');
  const old = new Date(Date.now() - 40 * 86_400_000);
  utimesSync(file, old, old);
  expect((await collect()).events).toEqual([]);
});

test('sessions inside LEFTOFF_HOME and ignored projects are dropped', async () => {
  install('session-basic.jsonl');
  ctx.config.ignore.projects = [realpathOr(FIXTURE_CWD)];
  expect((await collect()).events).toEqual([]);
  const r = parseCodexRecord(
    {
      timestamp: '2026-10-26T15:00:00.000Z',
      ordinal: 1,
      type: 'event_msg',
      payload: {
        type: 'item_completed',
        thread_id: 't',
        item: { type: 'UserMessage', content: [{ type: 'text', text: 'polish' }] },
      },
    },
    { cwd: paths().tmp },
  );
  expect(r).toHaveLength(1); // parsed…
  ctx.config.ignore.projects = [];
  const polish = join(dayDir, 'rollout-polish.jsonl');
  writeFileSync(
    polish,
    JSON.stringify({
      timestamp: '2026-10-26T15:00:00.000Z',
      ordinal: 0,
      type: 'session_meta',
      payload: { id: 'p', cwd: paths().tmp },
    }) +
      '\n' +
      JSON.stringify({
        timestamp: '2026-10-26T15:00:01.000Z',
        ordinal: 1,
        type: 'event_msg',
        payload: {
          type: 'item_completed',
          thread_id: 'p',
          item: { type: 'UserMessage', content: [{ type: 'text', text: 'polish' }] },
        },
      }) +
      '\n',
  );
  rmSync(join(dayDir, ROLLOUT));
  expect((await collect()).events).toEqual([]); // …but dropped by the collector
});

test('secrets in commands and output are redacted', async () => {
  writeFileSync(
    join(dayDir, 'rollout-secret.jsonl'),
    [
      { ordinal: 0, type: 'session_meta', payload: { id: 's', cwd: FIXTURE_CWD } },
      {
        ordinal: 1,
        type: 'event_msg',
        payload: {
          type: 'item_completed',
          thread_id: 's',
          item: {
            type: 'CommandExecution',
            command: ['/bin/zsh', '-lc', 'export GITHUB_TOKEN=ghp_' + 'a'.repeat(36) + ' && false'],
            status: 'failed',
            exit_code: 1,
            aggregated_output: 'psql postgres://admin:hunter2@db/x failed',
          },
        },
      },
    ]
      .map((r) => JSON.stringify({ timestamp: '2026-10-26T15:00:00.000Z', ...r }))
      .join('\n') + '\n',
  );
  const events = (await collect()).events;
  expect(events).toHaveLength(1);
  expect(JSON.stringify(events)).not.toMatch(/ghp_a|hunter2/);
});

test('the zstd fixture decompresses to the plain fixture (sanity check with the zstd CLI if present)', () => {
  let cli = true;
  try {
    execFileSync('zstd', ['--version'], { stdio: 'ignore' });
  } catch {
    cli = false;
  }
  if (!cli) return;
  const out = execFileSync('zstd', ['-dc', join(FIXTURES, 'session-basic.jsonl.zst')]);
  expect(out.equals(readFileSync(join(FIXTURES, 'session-basic.jsonl')))).toBe(true);
});

test('a command that completed with a non-zero exit code is command_failed', () => {
  const [e] = parseCodexRecord(
    {
      timestamp: '2026-10-26T15:00:00.000Z',
      ordinal: 5,
      type: 'event_msg',
      payload: {
        type: 'item_completed',
        thread_id: 't',
        item: {
          type: 'CommandExecution',
          command: ['bash', '-c', 'make'],
          status: 'completed',
          exit_code: 2,
          aggregated_output: 'make: *** [all] Error 2',
        },
      },
    },
    { cwd: FIXTURE_CWD },
  );
  expect(e).toMatchObject({ kind: 'command_failed', data: { command: 'make', exitCode: 2 } });
});

test('a failing test run piped through `| tail` (exit 0 from tail) is still test_failed', () => {
  const run = (output: string) =>
    parseCodexRecord(
      {
        timestamp: '2026-10-26T15:00:00.000Z',
        ordinal: 6,
        type: 'event_msg',
        payload: {
          type: 'item_completed',
          thread_id: 't',
          item: {
            type: 'CommandExecution',
            command: ['bash', '-lc', 'npm test 2>&1 | tail -20'],
            status: 'completed',
            exit_code: 0,
            aggregated_output: output,
          },
        },
      },
      { cwd: FIXTURE_CWD },
    ).map((e) => e.kind);
  expect(run('Tests: 1 failed, 4 passed')).toEqual(['test_failed']);
  expect(run('Tests: 5 passed')).toEqual(['command']);
});

test("a command piped into a filter: the filter's exit code is not the project's", () => {
  const run = (output: string) =>
    parseCodexRecord(
      {
        timestamp: '2026-10-26T15:00:00.000Z',
        ordinal: 8,
        type: 'event_msg',
        payload: {
          type: 'item_completed',
          thread_id: 't',
          item: {
            type: 'CommandExecution',
            command: ['bash', '-lc', 'npm test 2>&1 | grep -E "FAIL|failed"'],
            status: 'failed',
            exit_code: 1,
            aggregated_output: output,
          },
        },
      },
      { cwd: FIXTURE_CWD },
    ).map((e) => e.kind);
  expect(run('')).toEqual(['command']);
  expect(run('Tests: 2 failed, 5 passed')).toEqual(['command_failed', 'test_failed']);
});

test('a failing scratch command is stored with data.scratch = true', () => {
  const [e] = parseCodexRecord(
    {
      timestamp: '2026-10-26T15:00:00.000Z',
      ordinal: 7,
      type: 'event_msg',
      payload: {
        type: 'item_completed',
        thread_id: 't',
        item: {
          type: 'CommandExecution',
          command: ['bash', '-lc', 'node -e "boom()"'],
          status: 'completed',
          exit_code: 1,
          aggregated_output: 'ReferenceError: boom is not defined',
        },
      },
    },
    { cwd: FIXTURE_CWD },
  );
  expect(e).toMatchObject({ kind: 'command_failed', data: { scratch: true } });
});

test('only item_completed counts: an item_started record with the same item adds nothing', () => {
  const rec = (type: string) => ({
    timestamp: '2026-10-26T15:00:00.000Z',
    ordinal: type === 'item_started' ? 7 : 8,
    type: 'event_msg',
    payload: {
      type,
      thread_id: 't',
      item: { type: 'UserMessage', content: [{ type: 'text', text: 'hello' }] },
    },
  });
  expect(parseCodexRecord(rec('item_started'), { cwd: FIXTURE_CWD })).toEqual([]);
  expect(parseCodexRecord(rec('item_completed'), { cwd: FIXTURE_CWD })).toHaveLength(1);
});

test('soft deadline: several sessions and a big compressed one finish over runs without duplicates', async () => {
  install('session-basic.jsonl', 'rollout-a.jsonl');
  install('session-basic.jsonl', 'rollout-b.jsonl'); // same thread: dedupe makes it 0 new rows
  const big = Array.from({ length: 2500 }, (_, n) =>
    JSON.stringify({
      timestamp: '2026-10-26T15:00:00.000Z',
      ordinal: n + 1,
      type: 'event_msg',
      payload: {
        type: 'item_completed',
        thread_id: 'big',
        item: { type: 'UserMessage', content: [{ type: 'text', text: `p${n}` }] },
      },
    }),
  );
  const meta = JSON.stringify({
    timestamp: '2026-10-26T15:00:00.000Z',
    ordinal: 0,
    type: 'session_meta',
    payload: { id: 'big', cwd: FIXTURE_CWD },
  });
  writeFileSync(
    join(dayDir, 'rollout-big.jsonl.zst'),
    zstdCompressSync(Buffer.from([meta, ...big].join('\n') + '\n')),
  );
  ctx.deadline = 0;
  let inserted = 0;
  let runs = 0;
  for (let r = await collect(); r.events.length > 0 && runs < 20; r = await collect()) {
    runs++;
    inserted += commit(r);
  }
  expect(runs).toBeGreaterThan(2);
  expect(inserted).toBe(BASIC_KINDS.length + 2500);
});

test('soft deadline rotates between sessions: an always-growing session does not starve the others', async () => {
  const meta = (id: string) =>
    JSON.stringify({
      timestamp: '2026-10-26T15:00:00.000Z',
      ordinal: 0,
      type: 'session_meta',
      payload: { id, cwd: FIXTURE_CWD },
    }) + '\n';
  const prompt = (id: string, n: number) =>
    JSON.stringify({
      timestamp: '2026-10-26T15:00:00.000Z',
      ordinal: n,
      type: 'event_msg',
      payload: {
        type: 'item_completed',
        thread_id: id,
        item: { type: 'UserMessage', content: [{ type: 'text', text: `${id} ${n}` }] },
      },
    }) + '\n';
  const active = join(dayDir, 'rollout-a-active.jsonl');
  writeFileSync(active, meta('active') + prompt('active', 1));
  writeFileSync(join(dayDir, 'rollout-b-backlog.jsonl'), meta('backlog') + prompt('backlog', 1));
  ctx.deadline = 0;
  const seen = new Set<string>();
  for (let run = 2; run <= 4; run++) {
    const r = await collect();
    for (const e of r.events) seen.add(e.sessionRef ?? '');
    commit(r);
    appendFileSync(active, prompt('active', run));
  }
  expect(seen).toEqual(new Set(['active', 'backlog']));
});

test('probe failures are marked: ls /nope and the empty rg; the test run, lint and the interrupted npx are not', async () => {
  install('session-basic.jsonl');
  const failures = (await collect()).events
    .filter((e) => e.kind === 'command_failed')
    .map((e) => [e.data.command, e.data.probe === true]);
  expect(failures).toEqual([
    ['ls /nope', true],
    ["rg --files -g 'notes.md' -g 'NOTES.md' -g 'Notes.md'", true],
    ['node --test', false],
    ['npm run lint', false],
    ['npx --no-install eslint .', false], // exit 130: interrupted, a real failure
  ]);
});
