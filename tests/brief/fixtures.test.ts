// The real Claude Code and Codex sessions (tests/fixtures), ingested and turned
// into facts: only genuine loose ends remain open (owner decision after Task 9).
import { copyFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { Database } from 'better-sqlite3';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { buildFacts, problemText } from '../../src/brief/facts.ts';
import { DEFAULT_CONFIG, type Config } from '../../src/core/config.ts';
import { ingest, type IngestReport } from '../../src/ingest/ingest.ts';
import { openDb } from '../../src/store/db.ts';
import { createRepo, type Repo } from '../../src/store/repo.ts';

const FIXTURES = resolve(import.meta.dirname, '../fixtures');
const CLAUDE_ROOT = '/private/tmp/leftoff-fixture';
const CODEX_ROOT = '/private/tmp/leftoff-codex-fixture';
const realpathOr = (p: string) => {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
};

let tmp: string;
let db: Database;
let repo: Repo;
let report: IngestReport;
const config = structuredClone(DEFAULT_CONFIG) as Config;
const now = new Date('2026-10-26T20:00:00.000Z');
const saved = {
  home: process.env.LEFTOFF_HOME,
  claude: process.env.CLAUDE_CONFIG_DIR,
  codex: process.env.CODEX_HOME,
};

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'leftoff-realfacts-'));
  process.env.LEFTOFF_HOME = join(tmp, 'lhome');
  process.env.CLAUDE_CONFIG_DIR = join(tmp, 'claude');
  process.env.CODEX_HOME = join(tmp, 'codex');
  const claudeDir = join(tmp, 'claude', 'projects', 'p');
  const codexDir = join(tmp, 'codex', 'sessions', '2026', '10', '26');
  for (const d of [claudeDir, codexDir]) mkdirSync(d, { recursive: true });
  copyFileSync(join(FIXTURES, 'claude/session-basic.jsonl'), join(claudeDir, 's.jsonl'));
  copyFileSync(join(FIXTURES, 'codex/session-basic.jsonl'), join(codexDir, 'rollout-x.jsonl'));
  db = openDb();
  repo = createRepo(db);
  report = await ingest({ repo, config, now }, { budgetMs: 10_000 });
});

afterEach(() => {
  db.close();
  for (const [k, v] of Object.entries({
    LEFTOFF_HOME: saved.home,
    CLAUDE_CONFIG_DIR: saved.claude,
    CODEX_HOME: saved.codex,
  })) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(tmp, { recursive: true, force: true });
});

const facts = (root: string) =>
  buildFacts(realpathOr(root), { repo, config, report, working: null, now });

test('Claude session: only lint is open; ls /nope and the missing Read are probes', () => {
  const f = facts(CLAUDE_ROOT);
  expect(f.openProblems.map(problemText)).toEqual([
    '`npx --no-install eslint . 2>&1` — npm error npx canceled due to missing packages and no YES option: ["eslint@10.13.0"]',
    '`npm run lint 2>&1` — npm error Missing script: "lint"',
  ]);
  // The failing test run was genuine, and resolved by the passing re-run.
  expect(f.claimedDone?.contradictions).toHaveLength(2);
  const probes = repo
    .eventsSince('2000-01-01T00:00:00.000Z')
    .filter((e) => e.data.probe === true && e.source === 'claude');
  expect(probes.map((e) => e.data.command ?? e.data.tool)).toEqual(['ls /nope', 'Read']);
});

test('Codex session: lint and the interrupted npx are open; ls /nope and the empty rg are probes', () => {
  const f = facts(CODEX_ROOT);
  expect(f.openProblems.map(problemText)).toEqual([
    '`npx --no-install eslint .` — exit code 130',
    '`npm run lint` — npm error Missing script: "lint"',
  ]);
  const probes = repo
    .eventsSince('2000-01-01T00:00:00.000Z')
    .filter((e) => e.data.probe === true && e.source === 'codex');
  expect(probes.map((e) => e.data.command)).toEqual([
    'ls /nope',
    "rg --files -g 'notes.md' -g 'NOTES.md' -g 'Notes.md'",
  ]);
});
