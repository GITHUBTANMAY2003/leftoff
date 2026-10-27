import { expect, test } from 'vitest';
import type { BriefFacts } from '../../src/brief/facts.ts';
import { renderAgentContext } from '../../src/render/markdown.ts';
import { RAHUL_NOW, rahulFacts } from './helpers.ts';

const FIRST = '## Previous session in this project (from leftoff)';
const LAST =
  'This is an automatic summary of earlier work. Verify against the code before relying on it.';

test('agent context starts and ends with exact lines and is ≤ 4000 chars even with 200 files', () => {
  const f: BriefFacts = {
    ...rahulFacts(),
    unfinished: {
      files: Array.from({ length: 200 }, (_, i) => ({
        path: `src/module-${i}/file-${i}.ts`,
        status: 'modified',
      })),
      diffStat: '200 files changed',
    },
  };
  const out = renderAgentContext(f, 'Polished summary that must survive truncation.', {
    now: RAHUL_NOW,
  });
  const lines = out.split('\n');
  expect(lines[0]).toBe(FIRST);
  expect(lines.at(-1)).toBe(LAST);
  expect(out.length).toBeLessThanOrEqual(4000);
  expect(out).toContain('Polished summary that must survive truncation.'); // prose kept, lists cut
  expect(out).toMatch(/^- \+\d+ more$/m);
  expect(out).toContain('src/module-0/file-0.ts'); // shortened, not dropped
  expect(out).toContain(
    'Suggested next step: Resolve: `python scripts/send_test_email.py` — SMTP connection refused',
  );
});

test('the agent is told what was already tried, so it does not retry it (§1.1)', () => {
  const out = renderAgentContext(rahulFacts(), null, { now: RAHUL_NOW });
  expect(out).toContain('SMTP connection refused');
  expect(out).toContain('Already tried (did not fix it): changed port to 587; disabled TLS');
  expect(out).toContain('feature/forgot-password');
  expect(out).toContain('email_service.py');
  expect(out).toContain(
    'Suggested next step: Resolve: `python scripts/send_test_email.py` — SMTP connection refused',
  );
});

test('a huge single text field is still cut to fit, keeping the first and last lines', () => {
  const f: BriefFacts = { ...rahulFacts(), lastIntent: 'x'.repeat(10_000) };
  const out = renderAgentContext(f, 'y'.repeat(10_000), { now: RAHUL_NOW });
  expect(out.length).toBeLessThanOrEqual(4000);
  expect(out.startsWith(FIRST)).toBe(true);
  expect(out.endsWith(LAST)).toBe(true);
});

test('the 4000 limit holds for emoji-heavy text (UTF-16 length) without splitting an emoji', () => {
  const f: BriefFacts = { ...rahulFacts(), lastIntent: '😀'.repeat(5000) };
  const out = renderAgentContext(f, null, { now: RAHUL_NOW });
  expect(out.length).toBeLessThanOrEqual(4000);
  expect(out).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/); // no lone high surrogate
});

test('lists are never emptied: long items are shortened, at most 5 shown, then "+N more"', () => {
  const long = (i: number) => `npm run task-${i} ${'x'.repeat(900)}`;
  const f: BriefFacts = {
    ...rahulFacts(),
    openProblems: Array.from({ length: 16 }, (_, i) => ({
      error: `error ${i} ${'y'.repeat(600)}`,
      command: long(i),
      isTest: false,
      source: 'claude' as const,
      firstSeen: '',
      attempts: [long(100 + i)],
    })),
    unfinished: {
      files: Array.from({ length: 18 }, (_, i) => ({ path: `src/f${i}.ts`, status: 'modified' })),
      diffStat: null,
    },
  };
  const text = renderAgentContext(f, null, { now: RAHUL_NOW });
  expect(text.length).toBeLessThanOrEqual(4000);
  expect(text).not.toMatch(/…and \d+ more/);
  const section = (title: string) => {
    const lines = text.split('\n');
    const at = lines.indexOf(title);
    const end = lines.findIndex((l, i) => i > at && l === '');
    return lines.slice(at + 1, end === -1 ? undefined : end).filter((l) => l.startsWith('- '));
  };
  const problems = section('Open problems (unresolved):');
  expect(problems.length).toBeGreaterThanOrEqual(3);
  expect(problems.length).toBeLessThanOrEqual(6);
  expect(problems.at(-1)).toMatch(/^- \+\d+ more$/);
  expect(problems[0]).toMatch(/^- `npm run task-0 x+…/);
  const files = section('Uncommitted changes:');
  expect(files.slice(0, 2)).toEqual(['- src/f0.ts (modified)', '- src/f1.ts (modified)']);
  expect(files.at(-1)).toMatch(/^- \+\d+ more$/);
});

test('short lists that fit still show at most 5 items, then "+N more"', () => {
  const f: BriefFacts = {
    ...rahulFacts(),
    unfinished: {
      files: Array.from({ length: 8 }, (_, i) => ({ path: `src/f${i}.ts`, status: 'modified' })),
      diffStat: null,
    },
  };
  const lines = renderAgentContext(f, null, { now: RAHUL_NOW }).split('\n');
  const at = lines.indexOf('Uncommitted changes:');
  expect(lines.slice(at + 1, at + 8)).toEqual([
    '- src/f0.ts (modified)',
    '- src/f1.ts (modified)',
    '- src/f2.ts (modified)',
    '- src/f3.ts (modified)',
    '- src/f4.ts (modified)',
    '- +3 more',
    '',
  ]);
});

test('every output shows the cleaned command: no setup prefix, no trailing filter (owner decision after Task 14)', async () => {
  const { makeEvent } = await import('../../src/model/event.ts');
  const { buildFacts } = await import('../../src/brief/facts.ts');
  const { DEFAULT_CONFIG } = await import('../../src/core/config.ts');
  const { renderTerminal } = await import('../../src/render/terminal.ts');
  const { renderAutoBrief } = await import('../../src/render/auto.ts');
  const { renderLooseEnds } = await import('../../src/render/loose-ends.ts');
  const { openDb } = await import('../../src/store/db.ts');
  const { createRepo } = await import('../../src/store/repo.ts');
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = mkdtempSync(join(tmpdir(), 'leftoff-clean-'));
  const db = openDb(join(dir, 'x.db'));
  try {
    const repo = createRepo(db);
    const command =
      'source "$HOME/.cargo/env" && cargo test -p looplint_adapters | grep -E "^error" -A6';
    repo.insertEvents([
      makeEvent({
        source: 'shell',
        kind: 'command_failed',
        projectRoot: '/p/app',
        ts: new Date(RAHUL_NOW.getTime() - 3_600_000).toISOString(),
        sessionRef: null,
        summary: `\`${command}\` exited 101`,
        data: { command, exitCode: 101, error: 'test result: FAILED' },
        dedupeKey: 'clean-1',
      }),
    ]);
    const f = buildFacts('/p/app', {
      repo,
      config: structuredClone(DEFAULT_CONFIG) as never,
      report: null,
      working: null,
      now: RAHUL_NOW,
    });
    const want = '`cargo test -p looplint_adapters` — test result: FAILED';
    const outputs = [
      renderTerminal(f, null, { color: false, now: RAHUL_NOW }),
      renderAutoBrief(f, { color: false, now: RAHUL_NOW }),
      renderLooseEnds(
        [
          {
            project: f.project,
            branch: null,
            lastActiveAt: f.lastActiveAt as string,
            stale: false,
            claimedDone: null,
            openProblems: f.openProblems,
            uncommittedCount: 0,
            gitUnavailable: false,
          },
        ],
        RAHUL_NOW,
        { color: false },
      ),
      renderAgentContext(f, null, { now: RAHUL_NOW }),
    ];
    for (const out of outputs) {
      expect(out).toContain(want);
      expect(out).not.toContain('source "$HOME');
      expect(out).not.toContain('grep -E');
    }
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
