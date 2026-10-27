import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import {
  appendFileSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Database } from 'better-sqlite3';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { collectors } from '../../src/collectors/registry.ts';
import { shellCollector } from '../../src/collectors/shell.ts';
import type { CollectContext, CollectResult, Collector } from '../../src/collectors/types.ts';
import { DEFAULT_CONFIG, type Config } from '../../src/core/config.ts';
import { readRecentErrors } from '../../src/core/logger.ts';
import { ensureHome, paths } from '../../src/core/paths.ts';
import { ingest } from '../../src/ingest/ingest.ts';
import { makeEvent, type Source, type WorkEvent } from '../../src/model/event.ts';
import { openDb } from '../../src/store/db.ts';
import { createRepo } from '../../src/store/repo.ts';
import { commit, initRepo } from '../helpers/git.ts';

let tmp: string;
let db: Database;
let ctx: CollectContext;
const savedHome = process.env.LEFTOFF_HOME;
const EPOCH = '2000-01-01T00:00:00.000Z';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

beforeEach(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), 'leftoff-ingest-')));
  process.env.LEFTOFF_HOME = join(tmp, 'lhome');
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
  if (savedHome === undefined) delete process.env.LEFTOFF_HOME;
  else process.env.LEFTOFF_HOME = savedHome;
  rmSync(tmp, { recursive: true, force: true });
});

function event(source: Source, key: string, over: Partial<WorkEvent> = {}): WorkEvent {
  return makeEvent({
    source,
    kind: 'command',
    projectRoot: '/p',
    ts: new Date().toISOString(),
    sessionRef: null,
    summary: `event ${key}`,
    dedupeKey: key,
    ...over,
  });
}

// A fake collector: returns `result` (or throws / waits), records afterCommit calls.
function fake(
  name: Source,
  opts: {
    result?: Partial<CollectResult>;
    throws?: Error;
    delayMs?: number;
    available?: boolean;
    afterCommitThrows?: boolean;
  } = {},
): Collector & { afterCommits: number } {
  const c = {
    name,
    afterCommits: 0,
    async isAvailable() {
      return opts.available ?? true;
    },
    async collect(): Promise<CollectResult> {
      if (opts.delayMs) await sleep(opts.delayMs);
      if (opts.throws) throw opts.throws;
      return { events: [], pendingCursors: [], warnings: [], ...opts.result };
    },
    async afterCommit() {
      c.afterCommits++;
      if (opts.afterCommitThrows) throw new Error('cleanup failed');
    },
  };
  return c;
}

test('collectors(): enabled ones only, in the order claude, codex, shell, git', () => {
  expect(collectors(ctx.config).map((c) => c.name)).toEqual(['claude', 'codex', 'shell', 'git']);
  ctx.config.collectors.codex = false;
  ctx.config.collectors.shell = false;
  expect(collectors(ctx.config).map((c) => c.name)).toEqual(['claude', 'git']);
});

test('one collector throwing does not stop others', async () => {
  const report = await ingest(ctx, {
    collectors: [
      fake('claude', { throws: new Error('transcript exploded') }),
      fake('git', { result: { events: [event('git', 'g1')] } }),
    ],
  });
  expect(report.perSource.claude).toMatchObject({
    status: 'error',
    detail: 'transcript exploded',
    inserted: 0,
  });
  expect(report.perSource.git).toMatchObject({ status: 'ok', inserted: 1 });
  expect(readRecentErrors(5).join('\n')).toMatch(/claude.*transcript exploded/);
});

test('events and cursors are committed together; inserted counts exclude duplicates', async () => {
  ctx.repo.insertEvents([event('git', 'old')]);
  const git = fake('git', {
    result: {
      events: [event('git', 'old'), event('git', 'new')],
      pendingCursors: [{ key: '/p', value: 'abc' }],
    },
  });
  const report = await ingest(ctx, { collectors: [git] });
  expect(report.perSource.git).toMatchObject({ status: 'ok', inserted: 1 });
  expect(ctx.repo.getCursor('git', '/p')).toBe('abc');
  expect(git.afterCommits).toBe(1);
});

test('cursor not committed when insert fails', async () => {
  const bad = { ...event('claude', 'bad'), summary: null } as unknown as WorkEvent;
  const claude = fake('claude', {
    result: {
      events: [event('claude', 'ok'), bad],
      pendingCursors: [{ key: '/f.jsonl', value: '999' }],
    },
  });
  const report = await ingest(ctx, { collectors: [claude] });
  expect(report.perSource.claude.status).toBe('error');
  expect(ctx.repo.getCursor('claude', '/f.jsonl')).toBeNull();
  expect(ctx.repo.eventsSince(EPOCH)).toEqual([]);
  expect(claude.afterCommits).toBe(0);
});

test('events are rolled back when a cursor write fails after them (one transaction)', async () => {
  const claude = fake('claude', {
    result: {
      events: [event('claude', 'e1')],
      pendingCursors: [{ key: '/f.jsonl', value: null as unknown as string }], // NOT NULL fails
    },
  });
  const report = await ingest(ctx, { collectors: [claude] });
  expect(report.perSource.claude.status).toBe('error');
  expect(ctx.repo.eventsSince(EPOCH)).toEqual([]);
  expect(claude.afterCommits).toBe(0);
});

test('timeout marks collector error and keeps old cursor', async () => {
  ctx.repo.setCursor('codex', '/f.jsonl', 'old');
  const slow = fake('codex', {
    delayMs: 300,
    result: {
      events: [event('codex', 'late')],
      pendingCursors: [{ key: '/f.jsonl', value: 'new' }],
    },
  });
  const report = await ingest(ctx, { budgetMs: 50, collectors: [slow] });
  expect(report.perSource.codex).toMatchObject({ status: 'error', detail: 'timeout' });
  await sleep(350); // the late result must never be committed afterwards either
  expect(ctx.repo.getCursor('codex', '/f.jsonl')).toBe('old');
  expect(ctx.repo.eventsSince(EPOCH)).toEqual([]);
  expect(slow.afterCommits).toBe(0);
});

test('the budget is split evenly between collectors', async () => {
  // 2 collectors, 400 ms: each gets 200 ms. 150 ms fits, 300 ms does not.
  const report = await ingest(ctx, {
    budgetMs: 400,
    collectors: [fake('claude', { delayMs: 150 }), fake('codex', { delayMs: 300 })],
  });
  expect(report.perSource.claude.status).toBe('ok');
  expect(report.perSource.codex).toMatchObject({ status: 'error', detail: 'timeout' });
});

test('unavailable collectors are not_found; collectors not run are not_found "disabled"', async () => {
  const report = await ingest(ctx, { collectors: [fake('codex', { available: false })] });
  expect(report.perSource.codex).toMatchObject({ status: 'not_found', inserted: 0 });
  expect(report.perSource.claude).toMatchObject({ status: 'not_found', detail: 'disabled' });
  expect(Object.keys(report.perSource).sort()).toEqual(['claude', 'codex', 'git', 'shell']);
});

test('an afterCommit failure is a warning, not an error, and the data stays committed', async () => {
  const shell = fake('shell', {
    afterCommitThrows: true,
    result: { events: [event('shell', 's1')], pendingCursors: [{ key: 'ingesting', value: '{}' }] },
  });
  const report = await ingest(ctx, { collectors: [shell] });
  expect(report.perSource.shell.status).toBe('ok');
  expect(report.perSource.shell.warnings).toEqual([
    expect.stringMatching(/afterCommit.*cleanup failed/),
  ]);
  expect(ctx.repo.eventsSince(EPOCH)).toHaveLength(1);
});

test('collector warnings are passed through to the report', async () => {
  const report = await ingest(ctx, {
    collectors: [fake('claude', { result: { warnings: ['malformed:2:/f.jsonl'] } })],
  });
  expect(report.perSource.claude.warnings).toEqual(['malformed:2:/f.jsonl']);
});

test('last IngestReport with malformed warnings is stored in cursors', async () => {
  await ingest(ctx, {
    collectors: [fake('claude', { result: { warnings: ['malformed:2:/f.jsonl'] } })],
  });
  const stored = JSON.parse(ctx.repo.getCursor('ingest', 'last_report') ?? '{}');
  expect(stored.at).toBe(ctx.now.toISOString());
  expect(stored.perSource.claude.warnings).toEqual(['malformed:2:/f.jsonl']);
});

test('prunes old events at most hourly', async () => {
  const old = (key: string) => event('shell', key, { ts: '2020-01-01T00:00:00.000Z' });
  ctx.repo.insertEvents([old('o1'), event('shell', 'fresh')]);
  const first = await ingest(ctx, { collectors: [] });
  expect(first.prunedEvents).toBe(1);
  ctx.repo.insertEvents([old('o2')]);
  ctx.now = new Date(ctx.now.getTime() + 30 * 60_000); // 30 min later: no prune
  expect((await ingest(ctx, { collectors: [] })).prunedEvents).toBe(0);
  ctx.now = new Date(ctx.now.getTime() + 31 * 60_000); // 61 min after the first: prune
  expect((await ingest(ctx, { collectors: [] })).prunedEvents).toBe(1);
  expect(ctx.repo.eventsSince(EPOCH).map((e) => e.dedupeKey)).toEqual(['fresh']);
});

test('pruning uses retentionDays', async () => {
  ctx.config.retentionDays = 1;
  ctx.repo.insertEvents([
    event('shell', 'two-days', { ts: new Date(ctx.now.getTime() - 2 * 86_400_000).toISOString() }),
    event('shell', 'one-hour', { ts: new Date(ctx.now.getTime() - 3_600_000).toISOString() }),
  ]);
  expect((await ingest(ctx, { collectors: [] })).prunedEvents).toBe(1);
});

test('shell.log processed bytes are removed after commit; unprocessed partial line kept', async () => {
  const line = (cmd: string) => [1729764000000, 0, 5, 42, tmp, cmd].join('\t') + '\n';
  writeFileSync(paths().shellLog, line('echo one') + line('echo two') + 'partial-no-newline');
  const report = await ingest(ctx, { collectors: [shellCollector] });
  expect(report.perSource.shell).toMatchObject({ status: 'ok', inserted: 2 });
  // The fully read lines are gone from disk; only the file with the partial line remains.
  const left = readdirSync(paths().shellDir).filter((f) => f.startsWith('shell.log'));
  expect(left).toHaveLength(1);
  expect(readFileSync(join(paths().shellDir, left[0] as string), 'utf8')).toBe(
    line('echo one') + line('echo two') + 'partial-no-newline',
  );
  appendFileSync(join(paths().shellDir, left[0] as string), '\n');
  // once completed, it is a malformed line (not a command) and the file is cleaned up
  await ingest(ctx, { collectors: [shellCollector] });
  expect(readdirSync(paths().shellDir).filter((f) => f.startsWith('shell.log'))).toEqual([]);
});

test('ingest while another process holds a write transaction waits instead of throwing', async () => {
  // A second process takes the write lock for 600 ms (busy_timeout is 2000 ms).
  const holder = spawn(
    process.execPath,
    [
      '-e',
      `const D = require(${JSON.stringify(createRequire(import.meta.url).resolve('better-sqlite3'))});
       const db = new D(${JSON.stringify(paths().db)});
       db.pragma('busy_timeout = 2000');
       db.exec('BEGIN IMMEDIATE');
       process.stdout.write('locked\\n');
       setTimeout(() => { db.exec('COMMIT'); db.close(); }, 600);`,
    ],
    { stdio: ['ignore', 'pipe', 'inherit'] },
  );
  await new Promise<void>((resolve) => holder.stdout.once('data', () => resolve()));
  const started = Date.now();
  const report = await ingest(ctx, {
    budgetMs: 5000,
    collectors: [fake('git', { result: { events: [event('git', 'g1')] } })],
  });
  expect(report.perSource.git).toMatchObject({ status: 'ok', inserted: 1 });
  expect(Date.now() - started).toBeGreaterThanOrEqual(300); // it really waited
  await new Promise((r) => holder.on('close', r));
}, 15_000);

test('all four real collectors together, within the default budget', async () => {
  const fixtures = join(import.meta.dirname, '../fixtures');
  const saved = {
    claude: process.env.CLAUDE_CONFIG_DIR,
    codex: process.env.CODEX_HOME,
    git: process.env.GIT_CONFIG_GLOBAL,
  };
  process.env.CLAUDE_CONFIG_DIR = join(tmp, 'claude');
  process.env.CODEX_HOME = join(tmp, 'codex');
  process.env.GIT_CONFIG_GLOBAL = '/dev/null';
  try {
    const claudeDir = join(tmp, 'claude', 'projects', 'p');
    const codexDir = join(tmp, 'codex', 'sessions', '2026', '10', '26');
    for (const d of [claudeDir, codexDir]) mkdirSync(d, { recursive: true });
    copyFileSync(join(fixtures, 'claude/session-basic.jsonl'), join(claudeDir, 's.jsonl'));
    copyFileSync(join(fixtures, 'codex/session-basic.jsonl'), join(codexDir, 'rollout-x.jsonl'));
    const repoDir = initRepo(tmp, 'app');
    commit(repoDir, 'first commit');
    writeFileSync(paths().shellLog, [Date.now(), 0, 5, 42, repoDir, 'npm test'].join('\t') + '\n');
    const started = Date.now();
    const report = await ingest(ctx);
    const elapsed = Date.now() - started;
    for (const name of ['claude', 'codex', 'shell', 'git'] as const) {
      expect(report.perSource[name].status, name).toBe('ok');
    }
    expect(report.perSource.claude.inserted).toBe(23);
    expect(report.perSource.codex.inserted).toBe(33);
    expect(report.perSource.shell.inserted).toBe(1);
    expect(report.perSource.git.inserted).toBe(1); // the shell event made the repo a known project
    expect(elapsed).toBeLessThan(1500);
  } finally {
    for (const [k, v] of [
      ['CLAUDE_CONFIG_DIR', saved.claude],
      ['CODEX_HOME', saved.codex],
      ['GIT_CONFIG_GLOBAL', saved.git],
    ] as const) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
});

test('each collector gets a soft deadline inside its slice', async () => {
  let seen: number | undefined;
  const probe: Collector = {
    name: 'claude',
    async isAvailable() {
      return true;
    },
    async collect(c) {
      seen = c.deadline;
      return { events: [], pendingCursors: [], warnings: [] };
    },
  };
  const started = Date.now();
  await ingest(ctx, { budgetMs: 1000, collectors: [probe] });
  expect(seen).toBeGreaterThan(started);
  expect(seen).toBeLessThan(started + 1000); // before the hard limit
});

test('a collector that respects the soft deadline makes progress where a hard timeout would not', async () => {
  // Three "files" of 200 ms each, 300 ms budget (soft deadline at 60% = 180 ms):
  // without the soft deadline every run would start a second file, hit the hard
  // timeout and commit nothing.
  const done = new Set<string>();
  const slow: Collector = {
    name: 'claude',
    async isAvailable() {
      return true;
    },
    async collect(c) {
      const events: WorkEvent[] = [];
      for (const f of ['f1', 'f2', 'f3']) {
        if (ctx.repo.getCursor('claude', f) !== null) continue;
        if (events.length > 0 && c.deadline !== undefined && Date.now() >= c.deadline) break;
        await sleep(200);
        events.push(event('claude', f));
      }
      return {
        events,
        pendingCursors: events.map((e) => ({ key: e.dedupeKey, value: 'done' })),
        warnings: [],
      };
    },
  };
  for (let run = 0; run < 3 && done.size < 3; run++) {
    const report = await ingest(ctx, { budgetMs: 300, collectors: [slow] });
    expect(report.perSource.claude.status).toBe('ok');
    for (const e of ctx.repo.eventsSince(EPOCH)) done.add(e.dedupeKey);
  }
  expect(done).toEqual(new Set(['f1', 'f2', 'f3']));
});
