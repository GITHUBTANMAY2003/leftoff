import { existsSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import pkg from '../../../package.json' with { type: 'json' };
import { claudeDir } from '../../collectors/claude.ts';
import { codexDir } from '../../collectors/codex.ts';
import { configProblems, loadConfig } from '../../core/config.ts';
import { readRecentErrors } from '../../core/logger.ts';
import { paths } from '../../core/paths.ts';
import { relativeAgo } from '../../core/time.ts';
import type { IngestReport } from '../../ingest/ingest.ts';
import { claudePluginInstalled } from '../../install/claude-plugin.ts';
import {
  hasShellHook,
  installedShellScriptVersion,
  rcPathFor,
  type ShellName,
} from '../../install/shell-rc.ts';
import { shimStatus } from '../../install/shim.ts';
import { pickProviders } from '../../polish/chain.ts';
import { onPath } from '../../polish/providers/run-cli.ts';
import { openDb } from '../../store/db.ts';
import { createRepo } from '../../store/repo.ts';
import { plural } from '../../render/text.ts';

// `leftoff doctor` (§1.10): health checks, each with a fix hint. Never throws.

export interface Check {
  name: string;
  ok: boolean;
  detail?: string;
  hint?: string;
  warn?: boolean; // not ok, but not a failure: doesn't set the exit code
}
export interface DoctorResult {
  checks: Check[];
  exitCode: 0 | 1;
  recentErrors: string[];
}

const DAY_MS = 86_400_000;
const WEEK_MS = 7 * DAY_MS;
const SETUP = 'Run leftoff setup';
const ROLLOUT = /^rollout-.*\.jsonl(\.zst)?$/;
const SUPPORTED_PLATFORMS = new Set(['darwin', 'linux']);

const pass = (name: string, detail?: string): Check => ({
  name,
  ok: true,
  ...(detail !== undefined ? { detail } : {}),
});
const fail = (name: string, detail: string, hint?: string): Check => ({
  name,
  ok: false,
  detail,
  ...(hint !== undefined ? { hint } : {}),
});
const warn = (name: string, detail: string, hint?: string): Check => ({
  ...fail(name, detail, hint),
  warn: true,
});

// The newest mtime under dir (files only, recursive when asked), or null.
function newestMtime(
  dir: string,
  match: (name: string) => boolean,
  recursive: boolean,
): number | null {
  let newest: number | null = null;
  try {
    for (const name of readdirSync(dir, { recursive, encoding: 'utf8' })) {
      if (!match(basename(name))) continue;
      try {
        const st = statSync(join(dir, name));
        if (st.isFile() && (newest === null || st.mtimeMs > newest)) newest = st.mtimeMs;
      } catch {
        // vanished while reading
      }
    }
  } catch {
    return null;
  }
  return newest;
}

function loginShell(): ShellName | null {
  const name = basename(process.env.SHELL ?? '');
  return name === 'zsh' || name === 'bash' || name === 'fish' ? name : null;
}

export interface DoctorDeps {
  now?: Date;
  nodeVersion?: string; // test seams
  platform?: string;
}

function versionAtLeast(version: string, min: [number, number]): boolean {
  const [major = 0, minor = 0] = version.split('.').map(Number);
  return major > min[0] || (major === min[0] && minor >= min[1]);
}

export async function runDoctor(deps: DoctorDeps = {}): Promise<DoctorResult> {
  const now = deps.now ?? new Date();
  const checks: Check[] = [];
  const add = (c: Check) => checks.push(c);
  const p = paths();

  const node = deps.nodeVersion ?? process.versions.node;
  add(
    versionAtLeast(node, [22, 15])
      ? pass('Node ≥ 22.15', `v${node}`)
      : fail('Node ≥ 22.15', `v${node}`, 'Install Node 22.15 or newer'),
  );
  const platform = deps.platform ?? process.platform;
  add(
    SUPPORTED_PLATFORMS.has(platform)
      ? pass('Platform', platform)
      : fail('Platform', `${platform} is not supported`, 'leftoff runs on macOS and Linux'),
  );

  try {
    const mode = statSync(p.home).mode & 0o777;
    add(
      mode === 0o700
        ? pass('Home folder permissions', p.home)
        : fail(
            'Home folder permissions',
            `${p.home} is ${mode.toString(8)}`,
            `chmod 700 ${p.home}`,
          ),
    );
  } catch {
    add(fail('Home folder permissions', `${p.home} does not exist`, SETUP));
  }

  let report: (IngestReport & { at: string }) | null = null;
  let recentActivity: {
    shell: string | null;
    claudeStart: string | null;
    hidden: { probe: number; scratch: number };
  } = { shell: null, claudeStart: null, hidden: { probe: 0, scratch: 0 } };
  try {
    const db = openDb();
    try {
      // openDb migrated the schema or threw (SchemaTooNewError), so reaching
      // here means user_version is current.
      add(pass('Database', `schema ${String(db.pragma('user_version', { simple: true }))}`));
      const repo = createRepo(db);
      const raw = repo.getCursor('ingest', 'last_report');
      if (raw !== null) report = JSON.parse(raw) as IngestReport & { at: string };
      const events = repo.eventsSince(new Date(now.getTime() - WEEK_MS).toISOString());
      recentActivity = {
        shell: repo.lastEventTs({ source: 'shell' }),
        claudeStart: repo.lastEventTs({ kind: 'session_start' }),
        hidden: {
          probe: events.filter((e) => e.data.probe === true).length,
          scratch: events.filter((e) => e.data.scratch === true).length,
        },
      };
    } finally {
      db.close();
    }
  } catch (err) {
    add(
      fail(
        'Database',
        err instanceof Error ? err.message : String(err),
        `Move ${p.db} aside and run leftoff setup`,
      ),
    );
  }

  const problems = configProblems();
  add(
    problems.length === 0
      ? pass('Config')
      : fail('Config', problems.join('; '), `Fix or delete ${p.config}`),
  );
  const config = loadConfig();

  const shim = shimStatus();
  add(
    !shim.exists
      ? fail('CLI shim', `${p.shim} is missing`, SETUP)
      : shim.works
        ? pass('CLI shim', p.shim)
        : fail('CLI shim', `${p.shim} does not run`, 'shim broken, run leftoff setup'),
  );

  const shell = loginShell();
  const home = homedir();
  let hookInstalled = (['zsh', 'bash', 'fish'] as const).some((s) =>
    hasShellHook(rcPathFor(s, home)),
  );
  if (shell !== null) {
    const rc = rcPathFor(shell, home);
    const present = hasShellHook(rc);
    hookInstalled ||= present;
    add(
      present
        ? pass(`Shell hook (${shell})`, rc)
        : fail(`Shell hook (${shell})`, `no leftoff block in ${rc}`, SETUP),
    );
    const scriptVersion = installedShellScriptVersion(shell);
    add(
      scriptVersion === pkg.version
        ? pass('Shell scripts', `version ${scriptVersion}`)
        : warn(
            'Shell scripts',
            scriptVersion === null
              ? 'the copied shell script is missing'
              : `the copied shell script is version ${scriptVersion}, leftoff is ${pkg.version}`,
            SETUP,
          ),
    );
  }
  if (hookInstalled) {
    const logMtime = existsSync(p.shellLog) ? statSync(p.shellLog).mtimeMs : null;
    const lastShell = recentActivity.shell === null ? null : Date.parse(recentActivity.shell);
    const last = Math.max(lastShell ?? 0, logMtime ?? 0);
    add(
      last > 0 && now.getTime() - last <= WEEK_MS
        ? pass('Shell log', `last command ${relativeAgo(new Date(last).toISOString(), now)}`)
        : warn(
            'Shell log',
            'no command recorded in the last 7 days',
            'Open a new terminal and run a command',
          ),
    );
  }

  if (onPath('claude') || existsSync(claudeDir())) {
    if (!(await claudePluginInstalled())) {
      add(fail('Claude Code plugin', 'the leftoff plugin is not installed', SETUP));
    } else {
      const start = recentActivity.claudeStart;
      add(
        start !== null && now.getTime() - Date.parse(start) <= WEEK_MS
          ? pass('Claude Code plugin', `last session ${relativeAgo(start, now)}`)
          : warn(
              'Claude Code plugin',
              'installed, but no session started in the last 7 days',
              'Start Claude Code in a project',
            ),
      );
    }
  }

  const codex = codexDir();
  if (existsSync(codex)) {
    const sessions = join(codex, 'sessions');
    let readable = true;
    try {
      readdirSync(sessions);
    } catch {
      readable = false;
    }
    add(
      readable
        ? pass('Codex sessions', sessions)
        : warn(
            'Codex sessions',
            `cannot read ${sessions}`,
            'Check that Codex has run and the folder is readable',
          ),
    );
    const since = now.getTime() - WEEK_MS;
    const active = newestMtime(codex, (n) => n !== 'sessions', false);
    const rollout = newestMtime(sessions, (n) => ROLLOUT.test(n), true);
    add(
      active !== null && active >= since && (rollout === null || rollout < since)
        ? warn(
            'Codex storage format',
            'Codex may have changed its storage format; leftoff may be missing Codex sessions',
            'Check for a leftoff update',
          )
        : pass('Codex storage format'),
    );
  }

  if (report !== null) {
    const bad: { source: string; count: number }[] = [];
    for (const [source, s] of Object.entries(report.perSource)) {
      for (const w of s.warnings) {
        const m = /^malformed:(\d+):/.exec(w);
        if (m) bad.push({ source, count: Number(m[1]) });
      }
    }
    const total = bad.reduce((n, b) => n + b.count, 0);
    const sources = [...new Set(bad.map((b) => b.source))].join(', ');
    add(
      total === 0
        ? pass('Malformed lines')
        : warn(
            'Malformed lines',
            `${plural(total, 'line')} could not be read in the last ingest (${sources})`,
            'An agent may have changed its log format; check for a leftoff update',
          ),
    );
  }

  if (config.polish.provider === 'off') {
    add(pass('Polish provider', 'off'));
  } else {
    const providers = pickProviders(config);
    const available: string[] = [];
    for (const provider of providers) {
      try {
        if (await provider.available(config)) available.push(provider.name);
      } catch {
        // counts as unavailable
      }
    }
    add(
      available.length > 0
        ? pass('Polish provider', available.join(', '))
        : fail(
            'Polish provider',
            providers.length === 0
              ? `polish.provider is ${config.polish.provider}, but no provider is enabled`
              : `${providers.map((x) => x.name).join(', ')} not available`,
            'Run leftoff setup, or turn polish off: leftoff config set polish.provider off',
          ),
    );
  }

  const { probe, scratch } = recentActivity.hidden;
  add(
    pass(
      'Hidden from briefs',
      probe + scratch === 0
        ? 'none in the last 7 days'
        : `${plural(probe, 'probe failure')} and ${plural(scratch, 'scratch failure')} in the last 7 days (stored, not shown)`,
    ),
  );

  const recentErrors = readRecentErrors(5);
  const fresh = recentErrors.some((line) => {
    const at = Date.parse(line.slice(0, 24));
    return !Number.isNaN(at) && now.getTime() - at <= WEEK_MS;
  });
  add(
    fresh
      ? warn('Recent errors', `see ${p.logFile}`, 'The last lines are listed below')
      : pass('Recent errors', 'none in the last 7 days'),
  );

  return {
    checks,
    exitCode: checks.some((c) => !c.ok && !c.warn) ? 1 : 0,
    recentErrors,
  };
}

export function renderDoctor(r: DoctorResult): string {
  const lines: string[] = [];
  for (const c of r.checks) {
    const mark = c.ok ? '✓' : c.warn ? '!' : '✗';
    lines.push(`${mark} ${c.name}${c.detail ? ` — ${c.detail}` : ''}`);
    if (!c.ok && c.hint) lines.push(`    → ${c.hint}`);
  }
  if (r.recentErrors.length > 0) {
    lines.push('', 'Last errors from the log:', ...r.recentErrors.map((l) => `  ${l}`));
  }
  const failed = r.checks.filter((c) => !c.ok && !c.warn).length;
  const warned = r.checks.filter((c) => !c.ok && c.warn).length;
  lines.push(
    '',
    failed + warned === 0
      ? 'Everything looks fine.'
      : `${plural(failed, 'problem')}, ${plural(warned, 'warning')}.`,
  );
  return lines.join('\n');
}
