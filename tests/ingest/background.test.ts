import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { ensureHome, paths } from '../../src/core/paths.ts';
import {
  maybeSpawnBackgroundIngest,
  runInternalIngest,
  spawnBackgroundIngest,
} from '../../src/ingest/background.ts';
import type { ingest } from '../../src/ingest/ingest.ts';
import { openDb } from '../../src/store/db.ts';
import { createRepo, type Repo } from '../../src/store/repo.ts';

let tmp: string;
const KEYS = ['LEFTOFF_HOME', 'CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'GIT_CONFIG_GLOBAL'] as const;
const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));

beforeEach(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), 'leftoff-bg-')));
  process.env.LEFTOFF_HOME = join(tmp, 'lhome');
  process.env.CLAUDE_CONFIG_DIR = join(tmp, 'claude');
  process.env.CODEX_HOME = join(tmp, 'codex');
  process.env.GIT_CONFIG_GLOBAL = '/dev/null';
  ensureHome();
});

afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  rmSync(tmp, { recursive: true, force: true });
});

function withRepo<T>(fn: (repo: Repo) => T): T {
  const db = openDb();
  try {
    return fn(createRepo(db));
  } finally {
    db.close();
  }
}

test('background ingest spawns at most once every 10 minutes (R-D3)', () => {
  const spawned: string[] = [];
  const spawn = () => spawned.push('x');
  const t0 = new Date('2026-10-28T09:00:00.000Z');
  const at = (minutes: number) => new Date(t0.getTime() + minutes * 60_000);
  withRepo((repo) => {
    expect(maybeSpawnBackgroundIngest(repo, t0, spawn)).toBe(true);
    expect(repo.getCursor('ingest', 'last_bg')).toBe(t0.toISOString());
    expect(maybeSpawnBackgroundIngest(repo, at(1), spawn)).toBe(false);
    expect(maybeSpawnBackgroundIngest(repo, at(9.9), spawn)).toBe(false);
    expect(maybeSpawnBackgroundIngest(repo, at(10), spawn)).toBe(true);
    expect(repo.getCursor('ingest', 'last_bg')).toBe(at(10).toISOString());
  });
  expect(spawned).toHaveLength(2);
});

test('the spawned ingest is detached: the caller returns at once, it runs on its own (R-D3)', async () => {
  // A stand-in CLI that records how it was started, after a second.
  const marker = join(tmp, 'marker.json');
  const cli = join(tmp, 'fake-cli.mjs');
  writeFileSync(
    cli,
    `import { writeFileSync } from 'node:fs';
setTimeout(() => writeFileSync(${JSON.stringify(marker)}, JSON.stringify({
  args: process.argv.slice(2), internal: process.env.LEFTOFF_INTERNAL, cwd: process.cwd() })), 1000);
`,
  );
  const started = Date.now();
  spawnBackgroundIngest(cli);
  expect(Date.now() - started).toBeLessThan(300);
  expect(existsSync(marker)).toBe(false);
  for (let i = 0; i < 100 && !existsSync(marker); i++) await new Promise((r) => setTimeout(r, 50));
  expect(JSON.parse(readFileSync(marker, 'utf8'))).toEqual({
    args: ['internal', 'ingest'],
    internal: '1',
    cwd: realpathSync(paths().tmp),
  });
});

test('two concurrent internal ingests: only one runs (lock ingest:bg)', async () => {
  let calls = 0;
  let finish = () => {};
  const slow = (() => {
    calls++;
    return new Promise((resolve) => (finish = () => resolve({}))) as never;
  }) as unknown as typeof ingest;
  const first = runInternalIngest({ ingest: slow });
  await new Promise((r) => setTimeout(r, 50));
  await runInternalIngest({ ingest: slow }); // returns at once: the lock is held
  expect(calls).toBe(1);
  finish();
  await first;
  // Released: the next run goes ahead, with the background budget.
  let budget = 0;
  await runInternalIngest({
    ingest: (async (_ctx: unknown, opts: { budgetMs: number }) => {
      budget = opts.budgetMs;
      return {};
    }) as unknown as typeof ingest,
  });
  expect(budget).toBe(20_000);
});
