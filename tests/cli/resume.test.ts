import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { factsHash } from '../../src/brief/hash.ts';
import { runNote } from '../../src/cli/commands/note.ts';
import { runResume } from '../../src/cli/commands/resume.ts';
import { ensureHome, paths } from '../../src/core/paths.ts';
import { openDb } from '../../src/store/db.ts';
import { createRepo } from '../../src/store/repo.ts';
import { rahulEvents } from '../brief/rahul.ts';

let tmp: string;
let project: string;
const KEYS = [
  'LEFTOFF_HOME',
  'CLAUDE_CONFIG_DIR',
  'CODEX_HOME',
  'GIT_CONFIG_GLOBAL',
  'NO_COLOR',
] as const;
const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));

beforeEach(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), 'leftoff-resume-')));
  // Never read the developer's real agent logs or git config in tests.
  process.env.LEFTOFF_HOME = join(tmp, 'lhome');
  process.env.CLAUDE_CONFIG_DIR = join(tmp, 'claude');
  process.env.CODEX_HOME = join(tmp, 'codex');
  process.env.GIT_CONFIG_GLOBAL = '/dev/null';
  delete process.env.NO_COLOR;
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

function seed(events = rahulEvents(project)): void {
  const db = openDb();
  createRepo(db).insertEvents(events);
  db.close();
}

function withRepo<T>(fn: (repo: ReturnType<typeof createRepo>) => T): T {
  const db = openDb();
  try {
    return fn(createRepo(db));
  } finally {
    db.close();
  }
}

test('resume in a project with no data prints a friendly line and exits 0', async () => {
  const empty = join(tmp, 'empty');
  mkdirSync(empty);
  const r = await runResume({ cwd: empty, format: 'terminal', polish: false });
  expect(r.exitCode).toBe(0);
  expect(r.output).toContain('No activity recorded yet');
});

test('resume prints the brief for the project of cwd', async () => {
  seed();
  const r = await runResume({ cwd: project, format: 'terminal', polish: false });
  expect(r.exitCode).toBe(0);
  expect(r.output).toMatch(/^Where you left off — myapp · last active /);
  expect(r.output).toContain(
    '  ✗ SMTP connection refused\n    tried: changed port to 587 · disabled TLS',
  );
  expect(r.output).toContain('  → Resolve: SMTP connection refused');
  // eslint-disable-next-line no-control-regex -- matching ANSI color codes is the point
  expect(r.output).not.toMatch(/\x1b\[/); // not a TTY in tests → no color
});

test('--project picks another project; --json and --md formats', async () => {
  seed();
  const elsewhere = join(tmp, 'elsewhere');
  mkdirSync(elsewhere);
  const json = await runResume({ cwd: elsewhere, project, format: 'json', polish: false });
  const parsed = JSON.parse(json.output);
  expect(parsed.facts.nextStep).toBe('Resolve: SMTP connection refused');
  expect(parsed.polished).toBeNull();
  const md = await runResume({ cwd: elsewhere, project, format: 'md', polish: false });
  expect(md.output).toMatch(/^## Where you left off — myapp/);
});

test('resume ingests first: a failing command in the shell log shows up in the same brief', async () => {
  writeFileSync(
    paths().shellLog,
    [Date.now(), 2, 15, 42, project, 'make deploy'].join('\t') + '\n',
  );
  const r = await runResume({ cwd: project, format: 'terminal', polish: false });
  expect(r.output).toContain('`make deploy` exited 2');
  // git ran fine (installed; this folder just isn't a repo); no agent logs exist here.
  expect(r.output).toContain('Sources: claude –  git ✓  shell ✓  codex –');
});

test('resume records that the brief was shown for the latest activity', async () => {
  seed();
  await runResume({ cwd: project, format: 'terminal', polish: false });
  expect(withRepo((repo) => repo.briefShownFor(project))).toBe('2026-10-20T18:30:00.000Z');
});

test('a cached polished summary is shown only while its facts hash still matches', async () => {
  seed();
  const facts = JSON.parse(
    (await runResume({ cwd: project, format: 'json', polish: false })).output,
  ).facts;
  withRepo((repo) =>
    repo.saveBrief(
      project,
      factsHash(facts),
      JSON.stringify(facts),
      'Polished: SMTP blocks resets.',
      'claude-cli',
    ),
  );
  expect((await runResume({ cwd: project, format: 'terminal', polish: false })).output).toContain(
    'Polished: SMTP blocks resets.',
  );
  withRepo((repo) => repo.saveBrief(project, 'stale-hash', '{}', 'Old summary.', 'claude-cli'));
  expect(
    (await runResume({ cwd: project, format: 'terminal', polish: false })).output,
  ).not.toContain('Old summary.');
});

test('note appears in next resume output', async () => {
  seed();
  await runNote(project, 'next: ask ops whether port 587 is open');
  const r = await runResume({ cwd: project, format: 'terminal', polish: false });
  expect(r.output).toContain('Notes\n  • next: ask ops whether port 587 is open');
  expect(r.output).toContain('  → ask ops whether port 587 is open');
});
