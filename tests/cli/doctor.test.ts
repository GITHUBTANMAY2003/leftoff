import { chmodSync, mkdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { expect, test } from 'vitest';
import pkg from '../../package.json' with { type: 'json' };
import { renderDoctor, runDoctor, type DoctorResult } from '../../src/cli/commands/doctor.ts';
import { DEFAULT_CONFIG, saveConfig, type Config } from '../../src/core/config.ts';
import { logError } from '../../src/core/logger.ts';
import { ensureHome, paths } from '../../src/core/paths.ts';
import { installShellHook, installShellScripts } from '../../src/install/shell-rc.ts';
import { installShim } from '../../src/install/shim.ts';
import { openDb } from '../../src/store/db.ts';
import { createRepo, type Repo } from '../../src/store/repo.ts';
import { useTempHome } from '../helpers/home.ts';
import { ev } from '../store/helpers.ts';

const t = useTempHome();
const NOW = new Date('2026-10-28T12:00:00.000Z');
const DAY = 86_400_000;
const daysAgo = (n: number) => new Date(NOW.getTime() - n * DAY).toISOString();
const SHELL_DIR = resolve(import.meta.dirname, '../../shell');

const doctor = (over: Parameters<typeof runDoctor>[0] = {}) => runDoctor({ now: NOW, ...over });
const check = (r: DoctorResult, name: string) => {
  const c = r.checks.find((x) => x.name === name);
  if (!c) throw new Error(`no check "${name}" in: ${r.checks.map((x) => x.name).join(' | ')}`);
  return c;
};
function withRepo<T>(fn: (repo: Repo) => T): T {
  const db = openDb();
  try {
    return fn(createRepo(db));
  } finally {
    db.close();
  }
}

// What `leftoff setup` leaves behind, for a zsh user.
function installedState(): string {
  ensureHome();
  const cli = join(t.tmp, 'cli.mjs');
  writeFileSync(cli, 'console.log("0.0.0")\n');
  installShim(process.execPath, cli);
  installShellScripts(SHELL_DIR, pkg.version);
  installShellHook('zsh', join(t.home, '.zshrc'), join(paths().shellDir, 'leftoff.zsh'));
  withRepo((repo) => repo.insertEvents([ev('s1', { ts: daysAgo(1) })]));
  return cli;
}

test('a fresh machine: shim and shell hook are missing, each with a hint, exit code 1', async () => {
  const r = await doctor();
  expect(check(r, 'CLI shim')).toMatchObject({ ok: false, hint: 'Run leftoff setup' });
  expect(check(r, 'Shell hook (zsh)')).toMatchObject({ ok: false, hint: 'Run leftoff setup' });
  expect(r.exitCode).toBe(1);
});

test('after setup everything passes (no Claude Code or Codex here), exit code 0', async () => {
  installedState();
  const r = await doctor();
  expect(r.checks.filter((c) => !c.ok)).toEqual([]);
  expect(check(r, 'Node ≥ 22.15').ok).toBe(true);
  expect(check(r, 'Home folder permissions').ok).toBe(true);
  expect(check(r, 'Database').ok).toBe(true);
  expect(check(r, 'Config').ok).toBe(true);
  expect(check(r, 'CLI shim').ok).toBe(true);
  expect(check(r, 'Shell hook (zsh)').ok).toBe(true);
  expect(check(r, 'Shell scripts').ok).toBe(true);
  expect(check(r, 'Shell log').ok).toBe(true);
  expect(r.exitCode).toBe(0);
  expect(r.checks.map((c) => c.name)).not.toContain('Claude Code plugin'); // Claude not found
});

test('doctor fails when the shim points at a CLI that no longer exists', async () => {
  const cli = installedState();
  rmSync(cli);
  const c = check(await doctor(), 'CLI shim');
  expect(c.ok).toBe(false);
  expect(c.hint).toBe('shim broken, run leftoff setup');
});

test('doctor flags an old Node version and an unsupported platform', async () => {
  const r = await doctor({ nodeVersion: '22.14.0', platform: 'win32' });
  expect(check(r, 'Node ≥ 22.15')).toMatchObject({ ok: false });
  expect(check(r, 'Platform')).toMatchObject({ ok: false });
  const good = await doctor({ nodeVersion: '22.15.0', platform: 'linux' });
  expect(check(good, 'Node ≥ 22.15').ok).toBe(true);
  expect(check(good, 'Platform').ok).toBe(true);
});

test('doctor flags a home folder that others can read', async () => {
  installedState();
  chmodSync(t.lhome, 0o755);
  const c = check(await doctor(), 'Home folder permissions');
  expect(c).toMatchObject({ ok: false });
  expect(c.hint).toContain('chmod 700');
});

test('doctor warns (does not fail) when copied shell scripts are from an older version', async () => {
  installedState();
  installShellScripts(SHELL_DIR, '0.0.0-old');
  const r = await doctor();
  const c = check(r, 'Shell scripts');
  expect(c).toMatchObject({ ok: false, warn: true });
  expect(c.detail).toContain('0.0.0-old');
  expect(c.hint).toBe('Run leftoff setup');
  expect(r.exitCode).toBe(0);
});

test('doctor reports config problems with the key names', async () => {
  installedState();
  writeFileSync(paths().config, JSON.stringify({ retentionDays: 'many', nope: 1 }));
  const c = check(await doctor(), 'Config');
  expect(c.ok).toBe(false);
  expect(c.detail).toContain('invalid value for retentionDays');
  expect(c.detail).toContain('unknown key "nope"');
});

test('a shell hook without recent commands warns; the log file counts too', async () => {
  installedState();
  withRepo((repo) => repo.deleteAll());
  const c = check(await doctor(), 'Shell log');
  expect(c).toMatchObject({ ok: false, warn: true });
  writeFileSync(paths().shellLog, `${NOW.getTime()}\t0\t5\t1\t/p\tls\n`);
  utimesSync(paths().shellLog, NOW, NOW);
  expect(check(await doctor(), 'Shell log').ok).toBe(true);
});

test('Claude Code plugin: found but not installed fails, installed without sessions warns', async () => {
  installedState();
  mkdirSync(process.env.CLAUDE_CONFIG_DIR as string);
  const claude = join(t.bin, 'claude');
  writeFileSync(
    claude,
    `#!/bin/sh\n[ "$*" = "plugin list --json" ] && printf '%s' "$FAKE_LIST"\nexit 0\n`,
  );
  chmodSync(claude, 0o755);
  process.env.FAKE_LIST = '[]';
  const missing = check(await doctor(), 'Claude Code plugin');
  expect(missing).toMatchObject({ ok: false, hint: 'Run leftoff setup' });
  process.env.FAKE_LIST = JSON.stringify([{ id: 'leftoff@leftoff' }]);
  const idle = check(await doctor(), 'Claude Code plugin');
  expect(idle).toMatchObject({ ok: false, warn: true });
  expect(idle.detail).toContain('no session');
  withRepo((repo) =>
    repo.insertEvents([ev('cs', { source: 'claude', kind: 'session_start', ts: daysAgo(2) })]),
  );
  expect(check(await doctor(), 'Claude Code plugin').ok).toBe(true);
  delete process.env.FAKE_LIST;
});

function codexHome(files: { path: string; ageDays: number }[]): void {
  for (const f of files) {
    const full = join(process.env.CODEX_HOME as string, f.path);
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, '{}\n');
    const at = new Date(NOW.getTime() - f.ageDays * DAY);
    utimesSync(full, at, at);
  }
}

test('doctor warns when Codex is active but no rollout file is newer than 7 days', async () => {
  installedState();
  codexHome([
    { path: 'thread_history_1.sqlite', ageDays: 1 },
    { path: 'sessions/2026/10/01/rollout-old.jsonl', ageDays: 20 },
  ]);
  const r = await doctor();
  const c = check(r, 'Codex storage format');
  expect(c).toMatchObject({ ok: false, warn: true });
  expect(c.detail).toBe(
    'Codex may have changed its storage format; leftoff may be missing Codex sessions',
  );
  expect(check(r, 'Codex sessions').ok).toBe(true);
  codexHome([{ path: 'sessions/2026/10/27/rollout-new.jsonl', ageDays: 1 }]);
  expect(check(await doctor(), 'Codex storage format').ok).toBe(true);
});

test('Codex that has been idle for weeks is not a storage-format warning', async () => {
  installedState();
  codexHome([
    { path: 'thread_history_1.sqlite', ageDays: 30 },
    { path: 'sessions/2026/09/01/rollout-a.jsonl', ageDays: 30 },
  ]);
  expect(check(await doctor(), 'Codex storage format').ok).toBe(true);
});

test('malformed-line counts from the last ingest are a warning', async () => {
  installedState();
  withRepo((repo) =>
    repo.setCursor(
      'ingest',
      'last_report',
      JSON.stringify({
        at: NOW.toISOString(),
        prunedEvents: 0,
        perSource: {
          claude: {
            status: 'ok',
            inserted: 1,
            warnings: ['malformed:3:/x/a.jsonl', 'malformed:2:/x/b.jsonl'],
          },
          git: { status: 'ok', inserted: 0, warnings: [] },
          shell: { status: 'ok', inserted: 0, warnings: [] },
          codex: { status: 'not_found', inserted: 0, warnings: [] },
        },
      }),
    ),
  );
  const c = check(await doctor(), 'Malformed lines');
  expect(c).toMatchObject({ ok: false, warn: true });
  expect(c.detail).toContain('5 lines');
  expect(c.detail).toContain('claude');
});

test('polish provider: off is fine; an enabled provider that is not available fails', async () => {
  installedState();
  expect(check(await doctor(), 'Polish provider')).toMatchObject({ ok: true, detail: 'off' });
  const config = structuredClone(DEFAULT_CONFIG) as Config;
  config.polish = {
    provider: 'claude-cli',
    enabled: ['claude-cli'],
    ollamaModel: null,
    apiModel: null,
  };
  saveConfig(config);
  const c = check(await doctor(), 'Polish provider'); // no claude on PATH
  expect(c.ok).toBe(false);
  expect(c.detail).toContain('claude-cli');
  expect(c.hint).toContain('leftoff setup');
});

test('probe and scratch failures hidden in the last 7 days are counted (info)', async () => {
  installedState();
  withRepo((repo) =>
    repo.insertEvents([
      ev('p1', { kind: 'command_failed', ts: daysAgo(1), data: { probe: true } }),
      ev('p2', { kind: 'command_failed', ts: daysAgo(2), data: { probe: true } }),
      ev('p3', { kind: 'command_failed', ts: daysAgo(30), data: { probe: true } }),
      ev('x1', { kind: 'command_failed', ts: daysAgo(1), data: { scratch: true } }),
    ]),
  );
  const c = check(await doctor(), 'Hidden from briefs');
  expect(c.ok).toBe(true);
  expect(c.detail).toBe(
    '2 probe failures and 1 scratch failure in the last 7 days (stored, not shown)',
  );
});

test('the last 5 errors from the log are listed; recent ones warn', async () => {
  installedState();
  expect(check(await doctor(), 'Recent errors').ok).toBe(true);
  for (let i = 1; i <= 7; i++) logError('test', `boom ${i}`);
  const r = await doctor({ now: new Date() });
  expect(r.recentErrors).toHaveLength(5);
  expect(r.recentErrors.at(-1)).toContain('boom 7');
  expect(check(r, 'Recent errors')).toMatchObject({ ok: false, warn: true });
});

test('renderDoctor prints a mark per check, hints, errors, and a verdict', async () => {
  const r = await doctor();
  const out = renderDoctor(r);
  expect(out).toMatch(/^✗ CLI shim/m);
  expect(out).toMatch(/^ {4}→ Run leftoff setup$/m);
  expect(out).toMatch(/^✓ Database/m);
  expect(out.split('\n').at(-1)).toMatch(/^\d+ problems?/);
  const good = renderDoctor({ checks: [{ name: 'A', ok: true }], exitCode: 0, recentErrors: [] });
  expect(good.split('\n').at(-1)).toBe('Everything looks fine.');
});

test('a database from a newer leftoff fails the Database check with the reason', async () => {
  installedState();
  const db = openDb();
  db.pragma('user_version = 99');
  db.close();
  const c = check(await doctor(), 'Database');
  expect(c.ok).toBe(false);
  expect(c.detail).toMatch(/newer|schema/i);
});

test('doctor never throws, even when the database cannot be opened', async () => {
  ensureHome();
  mkdirSync(paths().db); // a folder where the database file should be
  const r = await doctor();
  expect(check(r, 'Database').ok).toBe(false);
  expect(r.exitCode).toBe(1);
});
