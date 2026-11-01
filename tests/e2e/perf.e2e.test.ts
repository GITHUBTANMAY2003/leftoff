import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { openDb } from '../../src/store/db.ts';
import { createRepo } from '../../src/store/repo.ts';
import { git } from '../helpers/git.ts';
import {
  budget,
  CLI,
  e2eDir,
  hasShell,
  measureCd,
  rahulScenario,
  run,
  stats,
  type Scenario,
} from './helpers.ts';

// Performance budgets (§1.12, Task 16), measured on the built CLI. The e2e
// project runs one file at a time, so nothing else competes for the CPU. Each
// test prints its numbers for the report.

let s: Scenario;
let cleanup: () => Promise<void>;

beforeEach(() => {
  const tmp = e2eDir('perf-');
  cleanup = tmp.cleanup;
  s = rahulScenario(tmp.dir);
});
afterEach(async () => cleanup());

const MODE = process.env.PERF_STRICT === '1' ? 'strict budgets' : 'CI: 3× budgets';
const report = (name: string, ms: number[]) => {
  const { median, p95 } = stats(ms);
  console.log(
    `${name}: median ${median.toFixed(1)} ms, p95 ${p95.toFixed(1)} ms (${ms.length} runs; ${MODE})`,
  );
  return { median, p95 };
};

test('resume p95 < 300 ms with no new data (20 runs)', () => {
  run(['resume'], { cwd: s.repo, env: s.env }); // the first run reads the scenario
  const ms = Array.from({ length: 20 }, () => run(['resume'], { cwd: s.repo, env: s.env }).ms);
  expect(report('resume', ms).p95).toBeLessThan(budget(300));
});

test('ingest of a 50 MB new transcript < 1500 ms', () => {
  run(['resume'], { cwd: s.repo, env: s.env });
  // ~50 MB of real-format records: commands and their results
  const lines: string[] = [];
  let bytes = 0;
  for (let i = 0; bytes < 49 * 1024 * 1024; i++) {
    const ts = new Date(Date.now() - 3_600_000 + i).toISOString();
    const base = { cwd: s.repo, sessionId: 'big', timestamp: ts, isSidechain: false };
    const use = JSON.stringify({
      ...base,
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [
          { type: 'tool_use', id: `t${i}`, name: 'Bash', input: { command: `make step${i % 50}` } },
        ],
      },
    });
    const result = JSON.stringify({
      ...base,
      type: 'user',
      message: {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: `t${i}`, content: 'x'.repeat(1500), is_error: false },
        ],
      },
    });
    lines.push(use, result);
    bytes += use.length + result.length + 2;
  }
  writeFileSync(
    join(s.env.CLAUDE_CONFIG_DIR as string, 'projects', '-e2e-myapp', 'big.jsonl'),
    lines.join('\n') + '\n',
  );
  const r = run(['internal', 'ingest'], { cwd: s.repo, env: s.env });
  console.log(
    `ingest of ${(bytes / 1024 / 1024).toFixed(1)} MB: ${r.ms.toFixed(0)} ms (budget ${budget(1500)} ms; ${MODE})`,
  );
  expect(r.status).toBe(0);
  expect(r.ms).toBeLessThan(budget(1500));
  // …and it read the whole file: one command per tool_use/tool_result pair
  const db = openDb(join(s.env.LEFTOFF_HOME as string, 'leftoff.db'));
  try {
    expect(createRepo(db).countEvents(realpathSync(s.repo))).toBeGreaterThanOrEqual(
      lines.length / 2,
    );
  } finally {
    db.close();
  }
});

test('shell hook overhead < 5 ms per command (zsh, 200 iterations, median)', () => {
  const zsh = spawnSync('zsh', ['-c', 'exit 0']);
  if (zsh.status !== 0) return; // no zsh on this machine: nothing to measure
  const script = resolve(import.meta.dirname, '../../shell/leftoff.zsh');
  const measure = `
    source ${JSON.stringify(script)}
    zmodload zsh/datetime
    for i in {1..200}; do
      t0=$EPOCHREALTIME
      __leftoff_preexec "make step$i"
      true
      __leftoff_precmd
      print -r -- $(( (EPOCHREALTIME - t0) * 1000 ))
    done`;
  const r = spawnSync('zsh', ['-f', '-i', '-c', measure], {
    cwd: s.repo,
    env: { ...s.env, PS1: '' },
    encoding: 'utf8',
  });
  const ms = r.stdout.trim().split('\n').map(Number);
  expect(ms).toHaveLength(200);
  expect(report('zsh hook per command', ms).median).toBeLessThan(budget(5));
});

// Task 16 Step 2a: with no brief due, cd into another project costs < ~20 ms.
test.each(['zsh', 'bash', 'fish'] as const)(
  '%s: cd into a project with no brief due < 20 ms (median of 20)',
  async (shell) => {
    if (!hasShell(shell)) return;
    const lhome = s.env.LEFTOFF_HOME as string;
    const shim = join(lhome, 'bin', 'leftoff');
    mkdirSync(join(lhome, 'bin'), { recursive: true });
    writeFileSync(
      shim,
      `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(CLI)} "$@"\n`,
    );
    chmodSync(shim, 0o755);
    const [a, b] = ['projA', 'projB'].map((name) => {
      const dir = join(s.dir, name);
      mkdirSync(dir);
      git(dir, ['init', '-q']);
      return realpathSync(dir);
    }) as [string, string];
    const env = { ...s.env, LEFTOFF_INTERNAL: undefined };
    const ms = await measureCd(shell, resolve(import.meta.dirname, '../../shell'), [a, b], env);
    expect(ms).toHaveLength(20);
    expect(report(`${shell} cd, no brief due`, ms).median).toBeLessThan(budget(20));
  },
);

// Task 16 Step 2b: the hooks as Claude Code runs them — through the shim,
// with JSON on stdin — one at a time, 20 runs each.
test.each([
  ['claude-session-start', 2000],
  ['claude-stop', 500],
  ['claude-session-end', 500],
] as const)('%s through the shim: median and p95 within %i ms (20 runs)', (hook, limit) => {
  const lhome = s.env.LEFTOFF_HOME as string;
  const shim = join(lhome, 'bin', 'leftoff');
  mkdirSync(join(lhome, 'bin'), { recursive: true });
  writeFileSync(
    shim,
    `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(CLI)} "$@"\n`,
  );
  chmodSync(shim, 0o755);
  run(['resume'], { cwd: s.repo, env: s.env }); // the scenario is already read, as on a real machine
  const input = JSON.stringify({
    session_id: 'perf',
    cwd: s.repo,
    hook_event_name: hook,
    source: 'startup',
    reason: 'exit',
  });
  const ms = Array.from({ length: 20 }, () => {
    const started = performance.now();
    const r = spawnSync(shim, ['hook', hook], { cwd: s.repo, env: s.env, input, encoding: 'utf8' });
    expect(r.status).toBe(0);
    return performance.now() - started;
  });
  const { median, p95 } = report(`hook ${hook}`, ms);
  expect(median).toBeLessThan(budget(limit));
  expect(p95).toBeLessThan(budget(limit));
});
