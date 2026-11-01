import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { factsHash } from '../../src/brief/hash.ts';
import { runNote } from '../../src/cli/commands/note.ts';
import { runResume } from '../../src/cli/commands/resume.ts';
import { DEFAULT_CONFIG, saveConfig, type Config } from '../../src/core/config.ts';
import type { PolishProvider } from '../../src/polish/types.ts';
import { ensureHome, paths } from '../../src/core/paths.ts';
import { openDb } from '../../src/store/db.ts';
import { createRepo } from '../../src/store/repo.ts';
import { makeEvent } from '../../src/model/event.ts';
import { rahulEvents } from '../brief/rahul.ts';

let tmp: string;
let project: string;
const KEYS = [
  'LEFTOFF_HOME',
  'CLAUDE_CONFIG_DIR',
  'CODEX_HOME',
  'GIT_CONFIG_GLOBAL',
  'NO_COLOR',
  'PATH',
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

test('resume prints three sections: what you did, files you changed, what is left (after 15e)', async () => {
  seed();
  const r = await runResume({ cwd: project, format: 'terminal', polish: false });
  expect(r.exitCode).toBe(0);
  // not a git repo here: no branch, no diff, so no "Files you changed"
  expect(r.output).toMatch(
    /^myapp · last worked \S+ ago · about 1\.5 hours\n {2}What you did\n {4}You were working on: Built POST \/auth\/forgot-password endpoint\./,
  );
  expect(r.output).not.toContain('Files you changed');
  expect(r.output).toContain(
    "  What's left\n    • `python scripts/send_test_email.py` — SMTP connection refused",
  );
  expect(r.output).toMatch(
    /\n {4}Start here: fix "SMTP connection refused", then run\s+`python scripts\/send_test_email.py` again\.$/,
  );
  // eslint-disable-next-line no-control-regex -- matching ANSI color codes is the point
  expect(r.output).not.toMatch(/\x1b\[/); // not a TTY in tests → no color
});

test('resume --details: the same three sections, each problem with its error, command and attempts', async () => {
  seed();
  const r = await runResume({ cwd: project, format: 'details', polish: false });
  expect(r.output).toContain(
    '    • `python scripts/send_test_email.py` — SMTP connection refused\n      Error: SMTP connection refused\n      Command: python scripts/send_test_email.py\n      Already tried: ',
  );
});

test('in a git repo, "Files you changed" comes from the work window\'s diff', async () => {
  const git = (args: string[]) =>
    spawnSync('git', ['-C', project, ...args], {
      env: {
        ...process.env,
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_AUTHOR_NAME: 't',
        GIT_AUTHOR_EMAIL: 't@example.com',
        GIT_COMMITTER_NAME: 't',
        GIT_COMMITTER_EMAIL: 't@example.com',
      },
    });
  git(['init', '-q', '-b', 'feature/password-reset']);
  git(['config', 'user.email', 't@example.com']);
  writeFileSync(join(project, 'app.py'), 'print(1)\n');
  git(['add', '-A']);
  const fiveDaysAgo = new Date(Date.now() - 5 * 86_400_000).toISOString();
  spawnSync('git', ['-C', project, 'commit', '-q', '-m', 'init'], {
    env: {
      ...process.env,
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_AUTHOR_NAME: 't',
      GIT_AUTHOR_EMAIL: 't@example.com',
      GIT_COMMITTER_NAME: 't',
      GIT_COMMITTER_EMAIL: 't@example.com',
      GIT_AUTHOR_DATE: fiveDaysAgo,
      GIT_COMMITTER_DATE: fiveDaysAgo,
    },
  }); // before the work window
  mkdirSync(join(project, 'tests'));
  writeFileSync(
    join(project, 'mailer.py'),
    '"""Sends password-reset emails."""\ndef send_reset(user):\n    pass\n',
  );
  writeFileSync(
    join(project, 'tests', 'test_mailer.py'),
    'def test_sends():\n    pass\ndef test_retries():\n    pass\n',
  );
  writeFileSync(join(project, 'app.py'), 'from mailer import send_reset\nprint(1)\n');
  seed([
    makeEvent({
      source: 'claude',
      kind: 'user_prompt',
      projectRoot: project,
      ts: new Date(Date.now() - 600_000).toISOString(),
      sessionRef: 's',
      summary: 'Add password-reset emails',
      dedupeKey: 'git-test-prompt',
    }),
  ]);
  const r = await runResume({ cwd: project, format: 'terminal', polish: false });
  expect(r.output.replace(/\s+/g, ' ')).toContain(
    'You added a new module (sends password-reset emails) and 2 tests.',
  );
  expect(r.output).toContain(
    [
      '  Files you changed',
      '    • mailer.py — new: sends password-reset emails',
      '    • app.py — now uses the new send_reset',
      '    • test_mailer.py — new: 2 tests for mailer',
    ].join('\n'),
  );
});

test('--project picks another project; --json and --md formats', async () => {
  seed();
  const elsewhere = join(tmp, 'elsewhere');
  mkdirSync(elsewhere);
  const json = await runResume({ cwd: elsewhere, project, format: 'json', polish: false });
  const parsed = JSON.parse(json.output);
  expect(parsed.facts.nextStep).toBe(
    'Resolve: `python scripts/send_test_email.py` — SMTP connection refused',
  );
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
  expect(r.output).toContain('    Start here: get `make deploy` working.');
  // git ran fine (installed; this folder just isn't a repo); no agent logs exist here.
  const json = JSON.parse(
    (await runResume({ cwd: project, format: 'json', polish: false })).output,
  );
  expect(json.facts.sources).toEqual([
    { name: 'claude', status: 'not_found' },
    { name: 'git', status: 'ok' },
    { name: 'shell', status: 'ok' },
    { name: 'codex', status: 'not_found' },
  ]);
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

test('--polish runs the polish provider now and shows its paragraph above the facts', async () => {
  seed();
  const bin = join(tmp, 'bin');
  mkdirSync(bin);
  writeFileSync(
    join(bin, 'claude'),
    '#!/bin/sh\ncat > /dev/null\necho "Polished now: SMTP still blocks resets."\n',
  );
  chmodSync(join(bin, 'claude'), 0o755);
  process.env.PATH = `${bin}:/usr/bin:/bin`; // the fake claude, never the real one
  const config = structuredClone(DEFAULT_CONFIG) as Config;
  config.polish = { ...config.polish, provider: 'claude-cli', enabled: ['claude-cli'] };
  saveConfig(config);
  const without = (await runResume({ cwd: project, format: 'terminal', polish: false })).output;
  expect(without).not.toContain('Polished now');
  const out = (await runResume({ cwd: project, format: 'terminal', polish: true })).output;
  const lines = out.split('\n');
  expect(lines[1]).toBe('  Polished now: SMTP still blocks resets.'); // first, after line 1
  expect(out).toContain('Start here:');
  // Saved: a later resume without --polish reuses it while the facts match.
  expect((await runResume({ cwd: project, format: 'terminal', polish: false })).output).toContain(
    'Polished now',
  );
});

test('--polish while polish is off prints one hint line to stderr and still shows the brief', async () => {
  seed();
  const r = await runResume({ cwd: project, format: 'terminal', polish: true });
  expect(r.stderr).toBe(
    'Polish is off. Turn it on with `leftoff setup` or `leftoff config set polish.provider <claude-cli|ollama|…>`.',
  );
  expect(r.output).toContain('Start here:');
  expect(
    (await runResume({ cwd: project, format: 'terminal', polish: false })).stderr,
  ).toBeUndefined();
  // The CLI writes it to stderr, not stdout.
  const cli = resolve(import.meta.dirname, '../../src/cli/index.ts');
  const run = spawnSync(process.execPath, [cli, 'resume', '--polish'], {
    cwd: project,
    env: process.env,
    encoding: 'utf8',
  });
  expect(run.stderr).toBe(`${r.stderr}\n`);
  expect(run.stdout).not.toContain('Polish is off');
});

test('--polish with ollama prints the local-model notice before the call starts; other providers do not', async () => {
  seed();
  const events: string[] = [];
  const provider = (name: 'ollama' | 'claude-cli'): PolishProvider => ({
    name,
    available: () => Promise.resolve(true),
    polish: () => {
      events.push(`polish ${name}`);
      return Promise.resolve(`Summary from ${name}.`);
    },
  });
  const config = structuredClone(DEFAULT_CONFIG) as Config;
  config.polish = { ...config.polish, provider: 'auto', enabled: ['ollama', 'claude-cli'] };
  saveConfig(config);
  const notify = (line: string) => events.push(`notice ${line}`);
  await runResume({
    cwd: project,
    format: 'terminal',
    polish: true,
    notify,
    providers: [provider('ollama')],
  });
  expect(events).toEqual([
    'notice Generating summary with a local model, this can take a minute…',
    'polish ollama',
  ]);
  events.length = 0;
  withRepo((repo) => repo.deleteAll());
  seed();
  await runResume({
    cwd: project,
    format: 'terminal',
    polish: true,
    notify,
    providers: [provider('claude-cli')],
  });
  expect(events).toEqual(['polish claude-cli']);
});

test('note appears in next resume output', async () => {
  seed();
  await runNote(project, 'SMTP creds are in 1Password');
  await runNote(project, 'next: ask ops whether port 587 is open');
  const r = await runResume({ cwd: project, format: 'terminal', polish: false });
  expect(r.output).toContain('    • Note: SMTP creds are in 1Password');
  expect(r.output).toContain('    Start here: ask ops whether port 587 is open.');
  const details = await runResume({ cwd: project, format: 'details', polish: false });
  expect(details.output).toContain('    • Note: SMTP creds are in 1Password');
});
