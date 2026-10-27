import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { buildFacts } from '../../src/brief/facts.ts';
import { factsHash } from '../../src/brief/hash.ts';
import { DEFAULT_CONFIG, saveConfig, type Config } from '../../src/core/config.ts';
import { ensureHome, paths } from '../../src/core/paths.ts';
import {
  polishNow,
  runInternalSummarize,
  spawnBackgroundSummarize,
} from '../../src/polish/summarize.ts';
import type { PolishProvider } from '../../src/polish/types.ts';
import { openDb } from '../../src/store/db.ts';
import { createRepo, type Repo } from '../../src/store/repo.ts';
import { rahulEvents } from '../brief/rahul.ts';

let tmp: string;
let project: string;
const KEYS = ['LEFTOFF_HOME', 'CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'GIT_CONFIG_GLOBAL'] as const;
const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));

beforeEach(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), 'leftoff-summarize-')));
  process.env.LEFTOFF_HOME = join(tmp, 'lhome');
  process.env.CLAUDE_CONFIG_DIR = join(tmp, 'claude');
  process.env.CODEX_HOME = join(tmp, 'codex');
  process.env.GIT_CONFIG_GLOBAL = '/dev/null';
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
async function withRepoAsync(fn: (repo: Repo) => Promise<void>): Promise<void> {
  const db = openDb();
  try {
    await fn(createRepo(db));
  } finally {
    db.close();
  }
}
const seed = () => withRepo((repo) => repo.insertEvents(rahulEvents(project)));
const polishConfig = (provider: Config['polish']['provider'] = 'auto'): Config => {
  const c = structuredClone(DEFAULT_CONFIG) as Config;
  c.polish = { ...c.polish, provider, enabled: ['ollama'] };
  return c;
};

function fake(reply: string, delayMs = 0): PolishProvider & { calls: number } {
  const p = {
    name: 'ollama' as const,
    calls: 0,
    available: () => Promise.resolve(true),
    polish: async () => {
      p.calls++;
      await new Promise((r) => setTimeout(r, delayMs));
      return reply;
    },
  };
  return p;
}

const NOW = new Date('2026-10-21T09:00:00.000Z');

test('polishNow saves the polished summary with its facts hash and provider', async () => {
  seed();
  const provider = fake(' You were fixing SMTP. ');
  await withRepoAsync(async (repo) => {
    const config = polishConfig();
    const r = await polishNow(project, {
      repo,
      config,
      now: NOW,
      working: null,
      providers: [provider],
    });
    expect(r).toEqual({ polished: 'You were fixing SMTP.', provider: 'ollama' });
    const facts = buildFacts(project, { repo, config, report: null, working: null, now: NOW });
    expect(repo.getBrief(project)).toMatchObject({
      factsHash: factsHash(facts),
      polished: 'You were fixing SMTP.',
      provider: 'ollama',
    });
  });
});

test('cached polish reused when factsHash unchanged; no provider call', async () => {
  seed();
  await withRepoAsync(async (repo) => {
    const deps = { repo, config: polishConfig(), now: NOW, working: null };
    await polishNow(project, { ...deps, providers: [fake('First.')] });
    const second = fake('Second.');
    expect(await polishNow(project, { ...deps, providers: [second] })).toEqual({
      polished: 'First.',
      provider: 'ollama',
    });
    expect(second.calls).toBe(0);
  });
});

test('when every provider fails nothing is saved, so the next run tries again', async () => {
  seed();
  await withRepoAsync(async (repo) => {
    const deps = { repo, config: polishConfig(), now: NOW, working: null };
    expect(await polishNow(project, { ...deps, providers: [fake('')] })).toEqual({
      polished: null,
      provider: null,
    });
    expect(repo.getBrief(project)).toBeNull();
    const retry = fake('Now it works.');
    expect((await polishNow(project, { ...deps, providers: [retry] })).polished).toBe(
      'Now it works.',
    );
  });
});

test('a saved entry without polished text for the same facts is polished again', async () => {
  seed();
  await withRepoAsync(async (repo) => {
    const config = polishConfig();
    const facts = buildFacts(project, { repo, config, report: null, working: null, now: NOW });
    repo.saveBrief(project, factsHash(facts), JSON.stringify(facts), null, null);
    const provider = fake('Fresh.');
    const r = await polishNow(project, {
      repo,
      config,
      now: NOW,
      working: null,
      providers: [provider],
    });
    expect(r.polished).toBe('Fresh.');
    expect(provider.calls).toBe(1);
  });
});

test('a project with no recorded activity is not polished', async () => {
  const provider = fake('Nothing to say.');
  await withRepoAsync(async (repo) => {
    const r = await polishNow(project, {
      repo,
      config: polishConfig(),
      now: NOW,
      working: null,
      providers: [provider],
    });
    expect(r).toEqual({ polished: null, provider: null });
  });
  expect(provider.calls).toBe(0);
});

test('two concurrent summarizes: only one calls the provider', async () => {
  seed();
  saveConfig(polishConfig());
  const provider = fake('Polished once.', 100);
  await Promise.all([
    runInternalSummarize(project, { providers: [provider] }),
    runInternalSummarize(project, { providers: [provider] }),
  ]);
  expect(provider.calls).toBe(1);
  // The lock is released afterwards.
  expect(withRepo((repo) => repo.acquireLock(`summarize:${project}`, 'someone-else', 1000))).toBe(
    true,
  );
});

test('internal summarize with polish off still ingests and calls no provider', async () => {
  // A real Claude session for the fixture project, waiting to be ingested.
  const claudeProject = join(tmp, 'claude', 'projects', 'p');
  mkdirSync(claudeProject, { recursive: true });
  copyFileSync(
    resolve(import.meta.dirname, '../fixtures/claude/session-basic.jsonl'),
    join(claudeProject, 's.jsonl'),
  );
  seed(); // the project has activity, so polish would run if it were on
  saveConfig(polishConfig('off'));
  const provider = fake('Should not happen.');
  await runInternalSummarize(project, { providers: [provider] });
  expect(provider.calls).toBe(0);
  expect(withRepo((repo) => repo.projects().length)).toBeGreaterThan(0);
});

test('spawnBackgroundSummarize starts `internal summarize` detached, with LEFTOFF_INTERNAL=1, in LEFTOFF_HOME/tmp', async () => {
  const record = join(tmp, 'spawned.json');
  const cli = join(tmp, 'fake-cli.mjs');
  writeFileSync(
    cli,
    `import { writeFileSync } from 'node:fs';
writeFileSync(${JSON.stringify(record)}, JSON.stringify({
  argv: process.argv.slice(2), internal: process.env.LEFTOFF_INTERNAL, cwd: process.cwd(),
}));
`,
  );
  spawnBackgroundSummarize(project, cli);
  for (let i = 0; i < 100 && !existsSync(record); i++) await new Promise((r) => setTimeout(r, 30));
  expect(JSON.parse(readFileSync(record, 'utf8'))).toEqual({
    argv: ['internal', 'summarize', '--project', project],
    internal: '1',
    cwd: realpathSync(paths().tmp),
  });
});
