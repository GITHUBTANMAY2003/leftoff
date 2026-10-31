import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { e2eDir, rahulScenario, run, SECRET, type Scenario } from './helpers.ts';

// The §1.1 scenario end to end (Task 16): real transcript, shell log and git
// repo in, the built CLI's output out. Golden files use the narrative format
// (Task 15b).

const golden = (name: string) =>
  readFileSync(resolve(import.meta.dirname, '../render/golden', name), 'utf8');
let s: Scenario;
let cleanup: () => Promise<void>;

beforeEach(() => {
  const tmp = e2eDir('rahul-');
  cleanup = tmp.cleanup;
  s = rahulScenario(tmp.dir);
});
afterEach(async () => cleanup());

test('rahul scenario end to end: `leftoff resume` matches the golden brief', () => {
  const r = run(['resume'], { cwd: s.repo, env: s.env });
  expect([r.status, r.stderr]).toEqual([0, '']);
  expect(r.stdout).toBe(golden('rahul-brief.txt'));
});

test('hook claude-session-start returns the same brief as context for the agent', () => {
  const input = JSON.stringify({
    session_id: 'next-morning',
    cwd: s.repo,
    hook_event_name: 'SessionStart',
    source: 'startup',
  });
  const r = run(['hook', 'claude-session-start'], { cwd: s.repo, env: s.env, input });
  expect(r.status).toBe(0);
  const context = JSON.parse(r.stdout).hookSpecificOutput.additionalContext as string;
  const lines = context.split('\n');
  expect(lines[0]).toBe('## Previous session in this project (from leftoff)');
  expect(lines.at(-1)).toBe(
    'This is an automatic summary of earlier work. Verify against the code before relying on it.',
  );
  expect(context).toContain('You were building forgot password: Added reset-token migration.');
  expect(context).toContain(
    'Stopped: `python scripts/send_test_email.py` — SMTP connection refused · 1 uncommitted file',
  );
  // the agent is told what was already tried, so it does not retry it (§1.1)
  expect(context).toContain(
    "Already tried (did not fix it): sed -i 's/25/587/' config.py; sed -i 's/use_tls=True/use_tls=False/' config.py",
  );
});

test('standup for the same scenario', () => {
  const r = run(['standup', '--since', '24h'], { cwd: s.repo, env: s.env });
  expect(r.status).toBe(0);
  expect(r.stdout.trimEnd()).toBe(
    [
      'Yesterday:',
      '- Built POST /auth/forgot-password endpoint',
      '- Added reset-token migration',
      '- Most changes in the top folder (2 files)',
      'Today:',
      '- Resolve: `python scripts/send_test_email.py` — SMTP connection refused',
      'Blockers:',
      '- `python scripts/send_test_email.py` — SMTP connection refused',
    ].join('\n'),
  );
});

test('bare `leftoff` lists the project with its open problem and uncommitted file', () => {
  const r = run([], { cwd: s.dir, env: s.env });
  expect(r.status).toBe(0);
  expect(r.stdout.trimEnd()).toBe(
    [
      'Loose ends across 1 project',
      '',
      'myapp (feature/forgot-password) · last worked 14h ago',
      '  You were building forgot password: Added reset-token migration.',
      '  Next: Get `python scripts/send_test_email.py` working (also: 1 uncommitted file)',
      '',
      'Run `leftoff resume` inside a project for details',
    ].join('\n'),
  );
});

test('a missing source (no ~/.codex) still gives a brief, with "codex –"', () => {
  expect(existsSync(s.env.CODEX_HOME as string)).toBe(false);
  const r = run(['resume', '--details'], { cwd: s.repo, env: s.env });
  expect(r.status).toBe(0);
  expect(r.stdout).toContain('Sources: claude ✓  git ✓  shell ✓  codex –');
});

test('secrets planted in the scenario never reach the database (Review Focus 3)', () => {
  run(['resume'], { cwd: s.repo, env: s.env });
  const lhome = s.env.LEFTOFF_HOME as string;
  for (const file of ['leftoff.db', 'leftoff.db-wal']) {
    const path = join(lhome, file);
    if (existsSync(path)) expect(readFileSync(path).includes(SECRET)).toBe(false);
  }
  // …while the commands themselves were recorded
  const r = run(['resume', '--json'], { cwd: s.repo, env: s.env });
  expect(r.stdout).not.toContain(SECRET);
});
