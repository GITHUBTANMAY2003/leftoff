import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { runHook } from '../../src/cli/commands/hook.ts';
import { DEFAULT_CONFIG, saveConfig, type Config } from '../../src/core/config.ts';
import { ensureHome } from '../../src/core/paths.ts';
import { openDb } from '../../src/store/db.ts';
import { createRepo, type Repo } from '../../src/store/repo.ts';
import { rahulEvents } from '../brief/rahul.ts';

let tmp: string;
let project: string;
const KEYS = [
  'LEFTOFF_HOME',
  'CLAUDE_CONFIG_DIR',
  'CODEX_HOME',
  'GIT_CONFIG_GLOBAL',
  'LEFTOFF_INTERNAL',
] as const;
const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));

beforeEach(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), 'leftoff-hook-')));
  // Never read the developer's real agent logs or git config in tests.
  process.env.LEFTOFF_HOME = join(tmp, 'lhome');
  process.env.CLAUDE_CONFIG_DIR = join(tmp, 'claude');
  process.env.CODEX_HOME = join(tmp, 'codex');
  process.env.GIT_CONFIG_GLOBAL = '/dev/null';
  delete process.env.LEFTOFF_INTERNAL;
  ensureHome();
  project = join(tmp, 'myapp');
  mkdirSync(project);
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
// Rahul's events, re-dated to end one hour ago so they are inside retentionDays.
function seed(): void {
  const events = rahulEvents(project);
  const shift = Date.now() - 3_600_000 - Date.parse(events.at(-1)?.ts as string);
  withRepo((repo) =>
    repo.insertEvents(
      events.map((e) => ({ ...e, ts: new Date(Date.parse(e.ts) + shift).toISOString() })),
    ),
  );
}
const stdinFor = (cwd: string, extra: Record<string, unknown> = {}) =>
  JSON.stringify({
    session_id: 'sess-1',
    transcript_path: join(tmp, 'claude', 'projects', 'p', 'sess-1.jsonl'),
    cwd,
    hook_event_name: 'SessionStart',
    source: 'startup',
    ...extra,
  });
const kinds = () =>
  withRepo((repo) => repo.eventsForProject(project, '1970-01-01T00:00:00.000Z')).map((e) => ({
    kind: e.kind,
    data: e.data,
  }));
const noSpawn = { spawnSummarize: () => {} };

test('session-start prints valid JSON with exact header line', async () => {
  seed();
  const out = JSON.parse(
    (await runHook('claude-session-start', stdinFor(project), noSpawn)).stdout,
  );
  expect(out.hookSpecificOutput.hookEventName).toBe('SessionStart');
  expect(out.hookSpecificOutput.additionalContext).toMatch(
    /^## Previous session in this project \(from leftoff\)/,
  );
  expect(out.hookSpecificOutput.additionalContext).toContain('SMTP connection refused');
});

test('session-start records session_start with the transcript path', async () => {
  seed();
  await runHook('claude-session-start', stdinFor(project), noSpawn);
  expect(kinds().filter((e) => e.kind === 'session_start')).toEqual([
    {
      kind: 'session_start',
      data: {
        transcriptPath: join(tmp, 'claude', 'projects', 'p', 'sess-1.jsonl'),
        source: 'startup',
      },
    },
  ]);
});

test('garbage stdin → empty stdout, no throw', async () => {
  for (const name of ['claude-session-start', 'claude-stop', 'claude-session-end'] as const) {
    expect(await runHook(name, 'not json {', noSpawn)).toEqual({ stdout: '' });
    expect(await runHook(name, '', noSpawn)).toEqual({ stdout: '' });
    expect(await runHook(name, '[1,2]', noSpawn)).toEqual({ stdout: '' });
  }
});

test('LEFTOFF_INTERNAL=1 → empty stdout and no events written', async () => {
  seed();
  const before = kinds().length;
  process.env.LEFTOFF_INTERNAL = '1';
  const spawned: string[] = [];
  const deps = { spawnSummarize: (root: string) => spawned.push(root) };
  for (const name of ['claude-session-start', 'claude-stop', 'claude-session-end'] as const) {
    expect(await runHook(name, stdinFor(project), deps)).toEqual({ stdout: '' });
  }
  expect(kinds()).toHaveLength(before);
  expect(spawned).toEqual([]);
});

test('session-start with no prior data prints nothing (but records the start)', async () => {
  expect(await runHook('claude-session-start', stdinFor(project), noSpawn)).toEqual({
    stdout: '',
  });
  expect(kinds().map((e) => e.kind)).toEqual(['session_start']);
});

test('session-start respects 2000 ms budget when ingest is slow', async () => {
  seed();
  const slowIngest = () => new Promise<never>(() => {}); // never finishes
  const started = Date.now();
  const r = await runHook('claude-session-start', stdinFor(project), {
    ...noSpawn,
    ingest: slowIngest,
  });
  const took = Date.now() - started;
  expect(r).toEqual({ stdout: '' });
  expect(took).toBeGreaterThanOrEqual(1900);
  expect(took).toBeLessThan(4000); // headroom for a loaded CI machine
});

test('stop records a checkpoint with the transcript path and prints nothing', async () => {
  const r = await runHook('claude-stop', stdinFor(project, { hook_event_name: 'Stop' }), noSpawn);
  expect(r).toEqual({ stdout: '' });
  expect(kinds()).toEqual([
    {
      kind: 'checkpoint',
      data: { transcriptPath: join(tmp, 'claude', 'projects', 'p', 'sess-1.jsonl') },
    },
  ]);
});

test('session-end always spawns summarize, also with polish off', async () => {
  const config = structuredClone(DEFAULT_CONFIG) as Config;
  expect(config.polish.provider).toBe('off');
  saveConfig(config);
  const spawned: string[] = [];
  const r = await runHook(
    'claude-session-end',
    stdinFor(project, { hook_event_name: 'SessionEnd', reason: 'prompt_input_exit' }),
    { spawnSummarize: (root) => spawned.push(root) },
  );
  expect(r).toEqual({ stdout: '' });
  expect(spawned).toEqual([project]);
  expect(kinds()).toEqual([{ kind: 'session_end', data: { reason: 'prompt_input_exit' } }]);
});

test('a missing cwd in stdin records nothing (the project is unknown)', async () => {
  const stdin = JSON.stringify({ session_id: 's', hook_event_name: 'Stop' });
  expect(await runHook('claude-stop', stdin, noSpawn)).toEqual({ stdout: '' });
  expect(withRepo((repo) => repo.projects())).toEqual([]);
});

test('a session inside LEFTOFF_HOME (a polish run) or an ignored project records nothing', async () => {
  const home = join(tmp, 'lhome', 'tmp');
  expect(await runHook('claude-stop', stdinFor(home), noSpawn)).toEqual({ stdout: '' });
  const config = structuredClone(DEFAULT_CONFIG) as Config;
  config.ignore.projects = [project];
  saveConfig(config);
  expect(await runHook('claude-stop', stdinFor(project), noSpawn)).toEqual({ stdout: '' });
  expect(withRepo((repo) => repo.projects())).toEqual([]);
});
