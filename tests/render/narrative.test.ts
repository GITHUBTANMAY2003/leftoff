import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import type { BriefFacts, OpenProblem } from '../../src/brief/facts.ts';
import type { WorkSummary } from '../../src/brief/work.ts';
import { narrativeLines, renderBrief } from '../../src/render/narrative.ts';
import { RAHUL_NOW, rahulFacts } from './helpers.ts';

// The brief scales with how much work was done (owner request after Task 17
// started): small 2–3 lines, medium ~5–6, large ~8–12 in sections. Fixed
// templates over the facts, no AI.

const golden = (name: string) => readFileSync(join(import.meta.dirname, 'golden', name), 'utf8');
const lines = (f: BriefFacts, polished: string | null = null) =>
  narrativeLines(f, polished, { now: RAHUL_NOW, width: null });
const terminal = (f: BriefFacts) => renderBrief(f, null, { color: false, now: RAHUL_NOW }) + '\n';

const problem = (command: string, error: string, isTest = false): OpenProblem => ({
  error,
  command,
  isTest,
  source: 'claude',
  firstSeen: '2026-10-20T18:00:00.000Z',
  attempts: [],
});
const clean = (f: BriefFacts): BriefFacts => ({
  ...f,
  unfinished: { files: [], diffStat: null },
  openProblems: [],
  claimedDone: null,
  nextStep: null,
});
const work = (f: BriefFacts, w: Partial<WorkSummary>): BriefFacts => ({
  ...f,
  work: { ...f.work, ...w },
});

// ---- the three sizes ----

test('medium work (the §1.1 scenario): about six lines (golden)', () => {
  expect(rahulFacts().work.size).toBe('medium');
  expect(terminal(rahulFacts())).toBe(golden('rahul-brief.txt'));
});

test('large work: sections for what got done and where it stopped (golden)', () => {
  const base = rahulFacts();
  const f: BriefFacts = {
    ...work(base, {
      size: 'large',
      activeMinutes: 750,
      days: 2,
      commits: [
        'bound the memory of loop guards',
        'first parser cut',
        'represent and/or expressions',
        'subscripted callees',
        'parser design notes',
      ].reduce<string[]>((all, c, i) => (i === 1 ? [...all, c, 'lexer tokens'] : [...all, c]), []),
      filesChanged: 37,
      topFolders: [
        { path: 'crates/parser', files: 24 },
        { path: 'crates/lexer', files: 9 },
        { path: 'docs', files: 4 },
      ],
      workingOn: 'working on parser and lexer',
    }),
    project: { root: '/w/parser', name: 'parser' },
    branch: 'feat/m2',
    unfinished: {
      files: [
        { path: 'a.rs', status: 'modified' },
        { path: 'b.rs', status: 'modified' },
      ],
      diffStat: null,
    },
    openProblems: [
      problem('cargo test -p parser', 'test result: FAILED', true),
      problem('cargo clippy -- -D warnings', 'error: unused variable'),
      problem('./scripts/bench.sh', 'connection refused'),
      problem('./scripts/deploy.sh', 'permission denied'),
    ],
    claimedDone: {
      source: 'claude',
      message: 'Tasks 0–4 are complete',
      at: '2026-10-20T18:30:00.000Z',
      contradictions: ['`cargo test -p parser` — test result: FAILED (still failing)'],
    },
    lastAgent: { source: 'claude', update: 'Tasks 0–4 are complete.', question: null },
  };
  const out = terminal(f);
  expect(out).toBe(golden('large-brief.txt'));
  const count = out.trimEnd().split('\n').length - 2; // without the details pointer
  expect(count).toBeGreaterThanOrEqual(8);
  expect(count).toBeLessThanOrEqual(14); // ~8–12, plus the 3 commit lines (owner decision after 15c)
});

test('small work: two or three lines', () => {
  const f = work(clean(rahulFacts()), {
    size: 'small',
    activeMinutes: 15,
    days: 1,
    commits: [],
    filesChanged: 1,
    topFolders: [{ path: 'src/components', files: 1 }],
    workingOn: 'working on: Rename the submit button to Save.',
  });
  const out = lines({ ...f, done: [], lastIntent: 'Rename the submit button to Save.' });
  expect(out).toEqual([
    'myapp · last worked 14h ago · about 15 min · branch feature/forgot-password',
    'You were working on: Rename the submit button to Save.',
    'Next: Continue: Rename the submit button to Save.',
  ]);
});

// ---- what each line says ----

test('a done-claim is one sentence; it replaces the separate problem line', () => {
  const f: BriefFacts = {
    ...rahulFacts(),
    openProblems: [
      problem('cargo test -p billing_adapters', 'test result: FAILED', true),
      problem('npm run lint', 'npm error Missing script: "lint"'),
    ],
    claimedDone: {
      source: 'claude',
      message: 'All tests pass',
      at: '2026-10-20T18:30:00.000Z',
      contradictions: ['`cargo test -p billing_adapters` — test result: FAILED (still failing)'],
    },
  };
  const out = lines(f);
  expect(out).toContain(
    'Claude said "All tests pass", but the billing_adapters tests are still failing.',
  );
  expect(out).toContain('Also open: 1 more problem · 1 uncommitted file');
  expect(out.at(-1)).toBe(
    'Next: Make the billing_adapters tests pass (`cargo test -p billing_adapters`).',
  );
});

test('a commit claim with uncommitted files reads as a sentence too', () => {
  const f: BriefFacts = {
    ...rahulFacts(),
    openProblems: [],
    claimedDone: {
      source: 'codex',
      message: 'Committed the fix',
      at: '2026-10-20T18:30:00.000Z',
      contradictions: ['1 uncommitted file'],
    },
  };
  const out = lines(f);
  expect(out).toContain('Codex said "Committed the fix", but 1 file is still uncommitted.');
  expect(out.at(-1)).toBe('Next: Commit the 1 file Codex said was committed.');
});

test("the agent's final question is the next step", () => {
  const f: BriefFacts = {
    ...clean(rahulFacts()),
    lastAgent: { source: 'claude', update: 'The cache is in.', question: 'Should I push?' },
  };
  expect(lines(f).at(-1)).toBe("Next: Answer Claude's question: Should I push?");
});

test('nothing open after commits: all changes committed, start the next task', () => {
  const out = lines(clean(rahulFacts()));
  expect(out).toContain('Stopped: nothing open, all changes committed');
  expect(out.at(-1)).toBe(
    'Next: Start the next task (everything from the last session is committed).',
  );
});

test('without commits, done says how many files changed and where', () => {
  const f = work(rahulFacts(), {
    commits: [],
    filesChanged: 12,
    topFolders: [
      { path: 'apps/server', files: 8 },
      { path: 'docs', files: 4 },
    ],
  });
  expect(lines({ ...f, done: [] })).toContain(
    'Done: changed 12 files, most in apps/server and docs',
  );
});

test('uncommitted files without problems: review and commit them', () => {
  const f: BriefFacts = {
    ...clean(rahulFacts()),
    done: [],
    unfinished: {
      files: ['a.ts', 'b.ts', 'c.ts', 'd.ts'].map((path) => ({ path, status: 'modified' })),
      diffStat: null,
    },
  };
  const out = lines(f);
  expect(out).toContain('Stopped: 4 uncommitted files');
  expect(out.at(-1)).toBe(
    'Next: Review and commit 4 uncommitted files (a.ts, b.ts, c.ts and 1 more).',
  );
});

test('every note is shown (P11); the newest "next:" note is the next step instead', () => {
  const f: BriefFacts = { ...rahulFacts(), notes: ['creds are in 1Password', 'next: ask ops'] };
  const out = lines(f);
  expect(out).toContain('Note: creds are in 1Password');
  expect(out).not.toContain('Note: next: ask ops');
  expect(out.at(-1)).toBe('Next: ask ops.');
});

test('without branch words or work topic, "You were" falls back to the first sentence of the request', () => {
  const f = work(rahulFacts(), { workingOn: null });
  expect(
    lines({ ...f, lastIntent: '@docs/plan.md Add rate limiting to the API. Then tests.' }),
  ).toContain('You were working on: Add rate limiting to the API.');
});

test('time: minutes, half hours, hours, and days', () => {
  const header = (activeMinutes: number, days: number) =>
    lines(work(rahulFacts(), { activeMinutes, days }))[0];
  expect(header(7, 1)).toContain('· about 5 min ·');
  expect(header(8, 1)).toContain('· about 10 min ·');
  expect(header(55, 1)).toContain('· about 1 hour ·');
  expect(header(100, 1)).toContain('· about 1.5 hours ·');
  expect(header(750, 3)).toContain('· about 12.5 hours over 3 days ·');
  expect(header(0, 0)).not.toContain('about');
});

test('a polished summary comes first, right after the first line', () => {
  const out = lines(rahulFacts(), 'Rahul was building password reset; SMTP refuses connections.');
  expect(out[1]).toBe('Rahul was building password reset; SMTP refuses connections.');
  expect(out[2]).toMatch(/^You were/);
});

test('terminal lines are cut to 100 characters, the error of a problem stays visible', () => {
  const f: BriefFacts = {
    ...rahulFacts(),
    openProblems: [
      problem(`./tools/${'deep/'.repeat(20)}run.sh --all`, 'connection refused by host'),
    ],
  };
  const out = renderBrief(f, null, { color: false, now: RAHUL_NOW }).split('\n');
  for (const l of out) expect([...l].length).toBeLessThanOrEqual(100);
  expect(out.find((l) => l.includes('Stopped:'))).toContain('connection refused by host');
});

test('a quote that is not a complete sentence is left out: "said it was done, but …"', () => {
  const f: BriefFacts = {
    ...rahulFacts(),
    openProblems: [problem('cargo test -p billing_adapters', 'test result: FAILED', true)],
    claimedDone: {
      source: 'codex',
      message: '…the 51 existing relevant tests have also finished…',
      at: '2026-10-20T18:30:00.000Z',
      contradictions: ['`cargo test -p billing_adapters` — test result: FAILED (still failing)'],
    },
  };
  expect(lines(f)).toContain(
    'Codex said it was done, but the billing_adapters tests are still failing.',
  );
});

test('a complete quote that does not fit the line is left out too, never cut', () => {
  const f: BriefFacts = {
    ...rahulFacts(),
    openProblems: [problem('cargo test -p billing_adapters', 'test result: FAILED', true)],
    claimedDone: {
      source: 'claude',
      message: `The plan records exactly where to pick up ${'and more '.repeat(8)}and it is done.`,
      at: '2026-10-20T18:30:00.000Z',
      contradictions: ['`cargo test -p billing_adapters` — test result: FAILED (still failing)'],
    },
  };
  const line = renderBrief(f, null, { color: false, now: RAHUL_NOW })
    .split('\n')
    .find((l) => l.includes(' said ')) as string;
  expect(line).toBe('  Claude said it was done, but the billing_adapters tests are still failing.');
});

test("the agent's last update shows whole sentences that fit, or nothing", () => {
  const update = (text: string) =>
    renderBrief(
      { ...rahulFacts(), lastAgent: { source: 'claude', update: text, question: null } },
      null,
      {
        color: false,
        now: RAHUL_NOW,
      },
    )
      .split('\n')
      .find((l) => l.includes("Claude's last update"));
  expect(
    update(
      `The build is paused. ${'I stopped the helper that was still running tests. '.repeat(2)}`,
    ),
  ).toBe(
    "  Claude's last update: The build is paused. I stopped the helper that was still running tests.",
  ); // a third would not fit
  expect(update(`${'word '.repeat(30)}done.`)).toBeUndefined(); // one sentence, too long
  expect(update('The build is paused. I stopped the one…')).toBe(
    "  Claude's last update: The build is paused.",
  );
});

test('first line without a branch', () => {
  expect(lines({ ...rahulFacts(), branch: null })[0]).toBe(
    'myapp · last worked 14h ago · about 1.5 hours',
  );
});

test('only the first line is bold with color', () => {
  const out = renderBrief(rahulFacts(), null, { color: true, now: RAHUL_NOW }).split('\n');
  expect(out[0]).toBe(
    '\x1b[1mmyapp · last worked 14h ago · about 1.5 hours · branch feature/forgot-password\x1b[0m',
  );
  expect(out.slice(1).join('\n')).not.toContain('\x1b[');
});

test('files at the project root are "the top folder"', () => {
  const f = work(rahulFacts(), {
    commits: [],
    filesChanged: 2,
    topFolders: [{ path: '.', files: 2 }],
  });
  expect(lines({ ...f, done: [] })).toContain('Done: changed 2 files, most in the top folder');
});

test('large: a problem the claim names is not listed again, nor are uncommitted files it mentions', () => {
  const adapters = problem('cargo test -p adapters', 'test result: FAILED', true);
  const again = problem('cargo test -p adapters -- star_import', 'test result: FAILED', true);
  const f: BriefFacts = {
    ...work(rahulFacts(), { size: 'large' }),
    openProblems: [adapters, again],
    claimedDone: {
      source: 'claude',
      message: 'Done',
      at: '2026-10-20T18:30:00.000Z',
      contradictions: ['`cargo test -p adapters` — test result: FAILED (still failing)'],
    },
  };
  const out = lines(f);
  expect(out.filter((l) => l.includes('adapters tests are'))).toHaveLength(1);
  const commitClaim: BriefFacts = {
    ...work(rahulFacts(), { size: 'large' }),
    openProblems: [],
    claimedDone: {
      source: 'claude',
      message: 'Committed',
      at: '2026-10-20T18:30:00.000Z',
      contradictions: ['1 uncommitted file'],
    },
  };
  expect(lines(commitClaim).filter((l) => l.includes('uncommitted'))).toHaveLength(1);
});

test('the request fallback uses the same filter: a statement or hedge is not what you were working on', () => {
  const f = work(rahulFacts(), { workingOn: null });
  const out = lines({ ...f, lastIntent: 'Our implementation stopped. I mean, why?' });
  expect(out.some((l) => l.startsWith('You were'))).toBe(false);
});

test('a claim whose "but" part is long drops the quote, never the "but"', () => {
  const p = problem('ollama serve', 'exit code 137');
  const f: BriefFacts = {
    ...rahulFacts(),
    openProblems: [p],
    claimedDone: {
      source: 'codex',
      message: `…chat; the progress document records the completed checks and ${'more '.repeat(20)}`,
      at: '2026-10-20T18:30:00.000Z',
      contradictions: ['`ollama serve` — exit code 137 (still failing)'],
    },
  };
  const line = renderBrief(f, null, { color: false, now: RAHUL_NOW })
    .split('\n')
    .find((l) => l.includes('Codex said')) as string;
  expect(line).toBe(
    '  Codex said it was done, but `ollama serve` still gets killed (exit code 137, often out of memory).',
  );
});

test('large: a long folders line keeps its file count', () => {
  const f = work(rahulFacts(), {
    size: 'large',
    filesChanged: 32,
    topFolders: [
      { path: 'crates/billing_adapters_engine', files: 12 },
      { path: 'crates/billing_workspace_loader', files: 10 },
      { path: 'crates/billing_knowledge_base', files: 6 },
    ],
  });
  const line = renderBrief(f, null, { color: false, now: RAHUL_NOW })
    .split('\n')
    .find((l) => l.includes('Most changes in')) as string;
  expect([...line].length).toBeLessThanOrEqual(100);
  expect(line.endsWith(' (32 files)')).toBe(true);
});

test('large: one or a few commits are listed one per line; a single commit stays on its line', () => {
  const large = (commits: string[]) =>
    lines(work(rahulFacts(), { size: 'large', commits, filesChanged: 0, topFolders: [] }));
  expect(large(['first', 'second'])).toEqual(
    expect.arrayContaining(['- 2 commits, the newest:', '  - second', '  - first']),
  );
  expect(large(['only one'])).toContain('- 1 commit: only one');
});
