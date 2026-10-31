import { spawnSync } from 'node:child_process';
import Database from 'better-sqlite3';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { git } from '../helpers/git.ts';

// End-to-end helpers (Task 16): the built CLI, run in a throwaway HOME, with
// the §1.1 scenario written the way the real tools write it — a git repo with
// dated commits, a Claude Code transcript and shell-log lines.

export const CLI = resolve(import.meta.dirname, '../../dist/cli.js');
const REPO_ROOT = resolve(import.meta.dirname, '../..');

// Loose ends leave out folders under the system temp dir (Task 15b), so the
// scenario lives in the repo's git-ignored .e2e-tmp/ instead.
export function e2eDir(prefix: string): { dir: string; cleanup: () => Promise<void> } {
  const parent = join(REPO_ROOT, '.e2e-tmp');
  mkdirSync(parent, { recursive: true });
  const dir = mkdtempSync(join(parent, prefix));
  return { dir, cleanup: () => removeAfterBackgroundJobs(dir) };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Hooks and `brief --auto` start detached background jobs (ingest, summarize)
// that would recreate the folder after it is removed. They hold a row in the
// `locks` table while they run: wait for jobs to start and finish (at most
// 15 s), then remove the folder.
async function removeAfterBackgroundJobs(dir: string): Promise<void> {
  const dbs = [join(dir, 'home', '.leftoff', 'leftoff.db'), join(dir, 'lhome', 'leftoff.db')];
  await sleep(400); // a job just spawned is still starting node
  for (const deadline = Date.now() + 15_000; Date.now() < deadline; await sleep(200)) {
    const held = dbs.some((db) => {
      if (!existsSync(db)) return false;
      try {
        const conn = new Database(db, { readonly: true, timeout: 1000 });
        try {
          return (conn.prepare('SELECT COUNT(*) AS n FROM locks').get() as { n: number }).n > 0;
        } finally {
          conn.close();
        }
      } catch {
        return false; // no locks table yet, or busy: treat as free
      }
    });
    if (!held) break;
  }
  rmSync(dir, { recursive: true, force: true });
}

export interface Scenario {
  dir: string;
  repo: string; // the project: myapp, on feature/forgot-password
  env: NodeJS.ProcessEnv;
  end: Date; // the last activity, 14 h before the test started
}

export const SECRET = 'hunter2'; // planted in commands; must never reach the database

const SESSION = 'e2e-rahul-session';
const SEND = 'python scripts/send_test_email.py';

// Rahul's Tuesday evening (§1.1), ending `hoursAgo` hours before now.
export function rahulScenario(dir: string, hoursAgo = 14): Scenario {
  const end = new Date(Date.now() - hoursAgo * 3_600_000);
  const at = (minutesBefore: number) => new Date(end.getTime() - minutesBefore * 60_000);
  const home = join(dir, 'home');
  const repo = join(dir, 'myapp');
  const claude = join(home, '.claude');
  const lhome = join(home, '.leftoff');
  mkdirSync(join(lhome, 'shell'), { recursive: true, mode: 0o700 });

  // git: two commits of yours, then email_service.py changed and not committed
  mkdirSync(repo, { recursive: true });
  git(repo, ['init', '-q', '-b', 'feature/forgot-password']);
  git(repo, ['config', 'user.email', 't@example.com']);
  const commitAt = (subject: string, when: Date, file: string, body: string) => {
    writeFileSync(join(repo, file), body);
    git(repo, ['add', '-A']);
    const iso = when.toISOString();
    git(repo, ['commit', '-q', '-m', subject], { GIT_AUTHOR_DATE: iso, GIT_COMMITTER_DATE: iso });
  };
  commitAt('Built POST /auth/forgot-password endpoint', at(70), 'email_service.py', 'v1\n');
  commitAt('Added reset-token migration', at(55), 'migration.sql', 'create table t;\n');
  writeFileSync(join(repo, 'email_service.py'), 'v2\n');

  // Claude Code: the request, three failing runs, two attempts, the last message
  const records: unknown[] = [];
  let n = 0;
  const base = (when: Date) => ({
    cwd: repo,
    sessionId: SESSION,
    timestamp: when.toISOString(),
    isSidechain: false,
    uuid: `u${n++}`,
  });
  const prompt = (when: Date, text: string) =>
    records.push({ ...base(when), type: 'user', message: { role: 'user', content: text } });
  const bash = (when: Date, command: string, output: string, isError: boolean) => {
    const id = `toolu_${n}`;
    records.push({
      ...base(when),
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [{ type: 'tool_use', id, name: 'Bash', input: { command } }],
      },
    });
    records.push({
      ...base(new Date(when.getTime() + 5000)),
      type: 'user',
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: id, content: output, is_error: isError }],
      },
    });
  };
  const say = (when: Date, text: string) =>
    records.push({
      ...base(when),
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'text', text }] },
    });
  prompt(at(90), 'Add a forgot-password flow: endpoint, reset token, email');
  bash(
    at(40),
    SEND,
    'Exit code 1\nSMTP connection refused\n  File "email_service.py", line 12',
    true,
  );
  bash(at(30), "sed -i 's/25/587/' config.py", '', false);
  bash(at(25), SEND, 'Exit code 1\nSMTP connection refused', true);
  bash(at(15), "sed -i 's/use_tls=True/use_tls=False/' config.py", '', false);
  bash(
    at(10),
    `curl -s -H "Authorization: Bearer ${SECRET}tokenvalue1234" https://smtp.example.test/health`,
    'ok',
    false,
  );
  bash(at(5), SEND, 'Exit code 1\nSMTP connection refused', true);
  say(end, 'The SMTP server still refuses the connection on both ports.');
  const transcripts = join(claude, 'projects', '-e2e-myapp');
  mkdirSync(transcripts, { recursive: true });
  writeFileSync(
    join(transcripts, `${SESSION}.jsonl`),
    records.map((r) => JSON.stringify(r)).join('\n') + '\n',
  );

  // your terminal: two commands in the repo, one with a secret
  const shellLine = (when: Date, exit: number, command: string) =>
    [when.getTime(), exit, 20, 4242, repo, command].join('\t');
  writeFileSync(
    join(lhome, 'shell', 'shell.log'),
    [shellLine(at(85), 0, 'git status'), shellLine(at(80), 0, `export DB_PASSWORD=${SECRET}`)].join(
      '\n',
    ) + '\n',
  );

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: home,
    LEFTOFF_HOME: lhome,
    CLAUDE_CONFIG_DIR: claude,
    CODEX_HOME: join(home, '.codex'), // never created: Codex "not found"
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    NO_COLOR: '1',
    SHELL: '/bin/zsh',
  };
  delete env.LEFTOFF_INTERNAL;
  delete env.LEFTOFF_QUIET;
  return { dir, repo, env, end };
}

export function run(
  args: string[],
  opts: { cwd: string; env: NodeJS.ProcessEnv; input?: string },
): { status: number | null; stdout: string; stderr: string; ms: number } {
  const started = performance.now();
  const r = spawnSync(process.execPath, [CLI, ...args], {
    cwd: opts.cwd,
    env: opts.env,
    input: opts.input ?? '',
    encoding: 'utf8',
  });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, ms: performance.now() - started };
}

// Median and 95th percentile (nearest rank) of a list of timings.
export function stats(ms: number[]): { median: number; p95: number } {
  const sorted = [...ms].sort((a, b) => a - b);
  const rank = (q: number) =>
    sorted[Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1)] as number;
  return { median: rank(0.5), p95: rank(0.95) };
}

export type Shell = 'zsh' | 'bash' | 'fish';
const SHELL_RUN: Record<Shell, { bin: string; args: string[] }> = {
  zsh: { bin: 'zsh', args: ['-f', '-i', '-c'] },
  bash: { bin: '/bin/bash', args: ['--norc', '--noprofile', '-i', '-c'] },
  fish: { bin: 'fish', args: ['--no-config', '-i', '-c'] },
};

export function hasShell(shell: Shell): boolean {
  return spawnSync(SHELL_RUN[shell].bin, ['-c', 'exit 0'], { stdio: 'ignore' }).status === 0;
}

// The cost of `cd` into another project with the hook (Task 16 Step 2a): the
// shell alternates between two projects, calling the hook after each cd and
// printing a tick; node times the ticks as they arrive. `runs` timings.
export async function measureCd(
  shell: Shell,
  scriptDir: string,
  [a, b]: [string, string],
  env: NodeJS.ProcessEnv,
  runs = 20,
): Promise<number[]> {
  const pairs = Math.ceil(runs / 2);
  const q = (p: string) => `'${p.replace(/'/g, `'\\''`)}'`;
  const step = (dir: string) =>
    shell === 'fish'
      ? `cd ${q(dir)}; __leftoff_auto; echo tick`
      : `cd ${q(dir)}; __leftoff_auto; echo tick`;
  const body = `${step(a)}; ${step(b)}`;
  const script =
    shell === 'fish'
      ? `source ${q(join(scriptDir, 'leftoff.fish'))}; ${body}; echo start; for i in (seq ${pairs}); ${body.replaceAll('; ', '; ')}; end`
      : `source ${q(join(scriptDir, `leftoff.${shell}`))}; ${body}; echo start; for i in ${Array.from({ length: pairs }, (_, i) => i + 1).join(' ')}; do ${body}; done`;
  const { spawn } = await import('node:child_process');
  return new Promise((done, fail) => {
    const child = spawn(SHELL_RUN[shell].bin, [...SHELL_RUN[shell].args, script], {
      cwd: a,
      env: { ...env, PS1: '' },
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const times: number[] = [];
    let started = false;
    let buffer = '';
    child.stdout.on('data', (chunk: Buffer) => {
      const now = performance.now();
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        if (line.trim() === 'start') started = true;
        if (started && (line.trim() === 'start' || line.trim() === 'tick')) times.push(now);
      }
    });
    child.on('error', fail);
    child.on('close', () => {
      const deltas = times.slice(1).map((t, i) => t - (times[i] as number));
      done(deltas.slice(0, runs));
    });
  });
}
