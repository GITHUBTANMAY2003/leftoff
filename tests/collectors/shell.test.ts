import {
  appendFileSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { Database } from 'better-sqlite3';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { shellCollector } from '../../src/collectors/shell.ts';
import type { CollectContext, CollectResult } from '../../src/collectors/types.ts';
import { DEFAULT_CONFIG, type Config } from '../../src/core/config.ts';
import { ensureHome, paths } from '../../src/core/paths.ts';
import { openDb } from '../../src/store/db.ts';
import { createRepo } from '../../src/store/repo.ts';

let tmp: string;
let db: Database;
let ctx: CollectContext;
let work: string;
const savedHome = process.env.LEFTOFF_HOME;

beforeEach(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), 'leftoff-shellc-')));
  process.env.LEFTOFF_HOME = join(tmp, 'lhome');
  ensureHome();
  work = join(tmp, 'work');
  mkdirSync(work);
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

function line(
  command: string,
  opts: { exit?: number; ts?: number; duration?: number; pid?: number; cwd?: string } = {},
): string {
  const { exit = 0, ts = 1729764000000, duration = 5, pid = 4242, cwd = work } = opts;
  return [ts, exit, duration, pid, cwd, command].join('\t') + '\n';
}

const log = () => paths().shellLog;
const ingesting = () => readdirSync(paths().shellDir).filter((f) => f.endsWith('.ingesting'));

// What ingest (Task 8) does after a successful collect: insert, commit cursors, afterCommit.
async function commit(r: CollectResult): Promise<void> {
  ctx.repo.insertEvents(r.events);
  for (const c of r.pendingCursors) ctx.repo.setCursor('shell', c.key, c.value);
  await shellCollector.afterCommit?.(ctx);
}

test('parses complete lines and ignores a partial last line', async () => {
  const first = line('echo one');
  const second = line('echo two', { ts: 1729764001000 });
  writeFileSync(log(), first + second + 'partial-no-newline');
  const r = await shellCollector.collect(ctx);
  expect(r.events.map((e) => e.summary)).toEqual(['echo one', 'echo two']);
  expect(r.pendingCursors).toHaveLength(1);
  const offsets = Object.values(JSON.parse(r.pendingCursors[0]?.value ?? '{}'));
  expect(offsets).toEqual([Buffer.byteLength(first + second)]);
});

test('maps a successful line to a command event', async () => {
  writeFileSync(log(), line('npm test', { ts: 1729764000123, duration: 12, pid: 77 }));
  const [e] = (await shellCollector.collect(ctx)).events;
  expect(e).toMatchObject({
    source: 'shell',
    kind: 'command',
    projectRoot: work,
    ts: '2024-10-24T10:00:00.123Z',
    sessionRef: 'shell:77',
    summary: 'npm test',
    data: { exitCode: 0, durationMs: 12, cwd: work },
  });
});

test('exit code != 0 becomes command_failed', async () => {
  writeFileSync(log(), line('ls /nope', { exit: 1 }));
  const [e] = (await shellCollector.collect(ctx)).events;
  expect(e?.kind).toBe('command_failed');
  expect(e?.summary).toBe('`ls /nope` exited 1');
  expect(e?.data.exitCode).toBe(1);
});

test('duration -1 (bash) is stored as durationMs null', async () => {
  writeFileSync(log(), line('echo hi', { duration: -1 }));
  expect((await shellCollector.collect(ctx)).events[0]?.data.durationMs).toBeNull();
});

test('redacts secrets in commands', async () => {
  writeFileSync(log(), line('export GITHUB_TOKEN=ghp_' + 'a'.repeat(36)));
  const [e] = (await shellCollector.collect(ctx)).events;
  expect(e?.summary).toBe('export GITHUB_TOKEN=[REDACTED]');
});

test('ignored project globs are dropped (the folder and everything under it)', async () => {
  const secret = join(tmp, 'secret');
  mkdirSync(join(secret, 'deep'), { recursive: true });
  ctx.config.ignore.projects = [secret];
  writeFileSync(
    log(),
    line('a', { cwd: secret }) + line('b', { cwd: join(secret, 'deep') }) + line('c'),
  );
  expect((await shellCollector.collect(ctx)).events.map((e) => e.summary)).toEqual(['c']);
});

test('ignore.projects supports * and a leading ~', async () => {
  ctx.config.ignore.projects = [join(tmp, 'clients', '*'), '~/leftoff-test-nonexistent/**'];
  mkdirSync(join(tmp, 'clients', 'acme'), { recursive: true });
  writeFileSync(
    log(),
    line('a', { cwd: join(tmp, 'clients', 'acme') }) +
      line('b', { cwd: join(homedir(), 'leftoff-test-nonexistent', 'x', 'y') }) +
      line('c', { cwd: join(tmp, 'clients') }),
  );
  expect((await shellCollector.collect(ctx)).events.map((e) => e.summary)).toEqual(['c']);
});

test('ignored commands are dropped', async () => {
  ctx.config.ignore.commands = ['vault *', 'pass'];
  writeFileSync(
    log(),
    line('vault read secret/db') + line('pass') + line('passwd-check') + line('ls'),
  );
  expect((await shellCollector.collect(ctx)).events.map((e) => e.summary)).toEqual([
    'passwd-check',
    'ls',
  ]);
});

test('commands run inside LEFTOFF_HOME are dropped', async () => {
  writeFileSync(log(), line('claude -p', { cwd: paths().tmp }) + line('ls'));
  expect((await shellCollector.collect(ctx)).events.map((e) => e.summary)).toEqual(['ls']);
});

test('a leading-space command that reached the log anyway is dropped', async () => {
  writeFileSync(log(), line(' echo secret') + line('ls'));
  expect((await shellCollector.collect(ctx)).events.map((e) => e.summary)).toEqual(['ls']);
});

test('malformed lines are skipped and counted in warnings', async () => {
  copyFileSync(resolve(import.meta.dirname, '../fixtures/shell/basic.log'), log());
  const r = await shellCollector.collect(ctx);
  expect(r.events.map((e) => [e.kind, e.summary])).toEqual([
    ['command', 'npm test'],
    ['command_failed', '`npm run build` exited 1'],
    ['command_failed', '`pyhton app.py` exited 127'],
    ['command', 'export GH_TOKEN=[REDACTED]'],
  ]);
  expect(r.warnings).toEqual([expect.stringMatching(/^malformed:1:.*\.ingesting$/)]);
});

test('re-reading without a commit yields the same events with the same dedupe keys', async () => {
  writeFileSync(log(), line('echo one'));
  const a = await shellCollector.collect(ctx);
  const b = await shellCollector.collect(ctx); // cursor never committed (ingest failed)
  expect(b.events.map((e) => e.dedupeKey)).toEqual(a.events.map((e) => e.dedupeKey));
});

test('after a commit the same lines are not read again', async () => {
  writeFileSync(log(), line('echo one'));
  await commit(await shellCollector.collect(ctx));
  expect((await shellCollector.collect(ctx)).events).toEqual([]);
});

test('lines appended after the rename land in the new shell.log and are read next run', async () => {
  writeFileSync(log(), line('before'));
  const r1 = await shellCollector.collect(ctx);
  appendFileSync(log(), line('after', { ts: 1729764009000 })); // a shell writing meanwhile
  await commit(r1);
  const r2 = await shellCollector.collect(ctx);
  expect(r1.events.map((e) => e.summary)).toEqual(['before']);
  expect(r2.events.map((e) => e.summary)).toEqual(['after']);
});

test('afterCommit deletes a fully read ingesting file', async () => {
  writeFileSync(log(), line('echo one'));
  await commit(await shellCollector.collect(ctx));
  expect(ingesting()).toEqual([]);
  expect(existsSync(log())).toBe(false);
});

test('afterCommit keeps an ingesting file that still has a partial last line', async () => {
  writeFileSync(log(), line('echo one') + 'partial');
  await commit(await shellCollector.collect(ctx));
  const left = ingesting();
  expect(left).toHaveLength(1);
  expect(readFileSync(join(paths().shellDir, left[0] as string), 'utf8')).toContain('partial');
});

test('a late line written into the renamed file is read on the next run, not lost', async () => {
  writeFileSync(log(), line('first'));
  const r1 = await shellCollector.collect(ctx);
  // A shell that opened the file just before the rename finishes its write.
  appendFileSync(
    join(paths().shellDir, ingesting()[0] as string),
    line('late', { ts: 1729764003000 }),
  );
  await commit(r1);
  expect(ingesting()).toHaveLength(1); // not deleted: it has unread bytes
  const r2 = await shellCollector.collect(ctx);
  expect(r2.events.map((e) => e.summary)).toEqual(['late']);
  await commit(r2);
  expect(ingesting()).toEqual([]);
});

test('a leftover ingesting file from a crashed run is processed first', async () => {
  writeFileSync(
    join(paths().shellDir, 'shell.log.1.1.ingesting'),
    line('old', { ts: 1729764000000 }),
  );
  writeFileSync(log(), line('new', { ts: 1729764100000 }));
  const r = await shellCollector.collect(ctx);
  expect(r.events.map((e) => e.summary)).toEqual(['old', 'new']);
  await commit(r);
  expect(ingesting()).toEqual([]);
});

test('an abandoned partial line (file untouched for over a minute) is dropped and counted', async () => {
  const stale = join(paths().shellDir, 'shell.log.1.1.ingesting');
  writeFileSync(stale, 'cut-off-mid-wri');
  const old = new Date(Date.now() - 5 * 60_000);
  utimesSync(stale, old, old);
  const r = await shellCollector.collect(ctx);
  expect(r.events).toEqual([]);
  expect(r.warnings).toEqual([expect.stringMatching(/^malformed:1:/)]);
  await commit(r);
  expect(ingesting()).toEqual([]);
});

test('reads at most ingest.maxBytesPerFilePerRun per file and continues next run', async () => {
  const a = line('a');
  ctx.config.ingest.maxBytesPerFilePerRun = Buffer.byteLength(a) + 5; // one line and a bit
  writeFileSync(log(), a + line('b', { ts: 1729764001000 }) + line('c', { ts: 1729764002000 }));
  const r1 = await shellCollector.collect(ctx);
  expect(r1.events.map((e) => e.summary)).toEqual(['a']);
  await commit(r1);
  const r2 = await shellCollector.collect(ctx);
  expect(r2.events.map((e) => e.summary)).toEqual(['b']);
});

test('no shell.log → no events; missing shell dir → isAvailable false', async () => {
  expect(await shellCollector.isAvailable(ctx)).toBe(true);
  expect(await shellCollector.collect(ctx)).toEqual({
    events: [],
    pendingCursors: [],
    warnings: [],
  });
  rmSync(paths().shellDir, { recursive: true });
  expect(await shellCollector.isAvailable(ctx)).toBe(false);
  expect((await shellCollector.collect(ctx)).events).toEqual([]);
});

test('an empty shell.log is not rotated', async () => {
  writeFileSync(log(), '');
  await shellCollector.collect(ctx);
  expect(ingesting()).toEqual([]);
});

test('the rotated file keeps its content until afterCommit', async () => {
  writeFileSync(log(), line('x'));
  await shellCollector.collect(ctx);
  const [name] = ingesting();
  expect(readFileSync(join(paths().shellDir, name as string), 'utf8')).toBe(line('x'));
});

test('a single line longer than maxBytesPerFilePerRun is skipped instead of stalling', async () => {
  ctx.config.ingest.maxBytesPerFilePerRun = 40;
  writeFileSync(log(), 'x'.repeat(100) + '\n' + line('ok').replace(work, '/w'));
  const seen: string[] = [];
  for (let run = 0; run < 10 && !seen.includes('ok'); run++) {
    const r = await shellCollector.collect(ctx);
    seen.push(...r.events.map((e) => e.summary));
    await commit(r);
  }
  expect(seen).toEqual(['ok']);
});
