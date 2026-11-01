import { describe, expect, test } from 'vitest';
import { branchPhrase, summarizeWork } from '../../src/brief/work.ts';
import { makeEvent, type EventKind, type Source, type WorkEvent } from '../../src/model/event.ts';

// How much work was done, and what it was about (owner request after Task 17
// started): deterministic signals only — sessions, commits, changed files,
// branch name, requests. Times are mid-morning UTC so every time zone between
// UTC-10 and UTC+12 sees the same calendar days.

let seq = 0;
function ev(
  root: string,
  ts: string,
  kind: EventKind,
  summary: string,
  data: Record<string, unknown> = {},
  source: Source = kind === 'commit' ? 'git' : 'claude',
): WorkEvent {
  return makeEvent({
    source,
    kind,
    projectRoot: root,
    ts,
    sessionRef: source === 'claude' ? 's' : null,
    summary,
    data,
    dedupeKey: `w${seq++}`,
  });
}
const edit = (root: string, ts: string, path: string) =>
  ev(root, ts, 'file_edit', `Edited ${path}`, { path: `${root}/${path}` });
// `n` events every 10 minutes from `start` (keeps one session going)
const every10 = (start: string, n: number, make: (ts: string, i: number) => WorkEvent) =>
  Array.from({ length: n }, (_, i) =>
    make(new Date(Date.parse(start) + i * 600_000).toISOString(), i),
  );

describe('Rust, large: two days, several commits', () => {
  const root = '/w/parser';
  const events = [
    ev(root, '2026-10-20T09:00:00.000Z', 'user_prompt', 'ok, start the M2 milestone'),
    ...every10('2026-10-20T09:05:00.000Z', 18, (ts, i) =>
      edit(root, ts, i % 2 ? `crates/parser/src/expr${i}.rs` : `crates/lexer/src/tok${i}.rs`),
    ),
    ev(root, '2026-10-20T12:00:00.000Z', 'commit', 'feat(parser): represent and/or expressions'),
    ev(root, '2026-10-20T12:10:00.000Z', 'commit', 'fix(lexer): bound the memory of loop guards'),
    ...every10('2026-10-21T09:00:00.000Z', 15, (ts, i) =>
      edit(root, ts, `crates/parser/src/stmt${i}.rs`),
    ),
    ev(root, '2026-10-21T11:30:00.000Z', 'commit', 'feat(parser): subscripted callees'),
    ev(root, '2026-10-21T11:40:00.000Z', 'commit', 'docs: parser design notes', {
      files: ['docs/parser.md'],
    }),
  ];
  const w = summarizeWork(events, { root, branch: 'feat/m2', gapMinutes: 45 });

  test('size, time, days, commits', () => {
    expect(w.size).toBe('large');
    expect(w.days).toBe(2);
    expect(w.activeMinutes).toBe(190 + 160); // 09:00–12:10, 09:00–11:40
    expect(w.commits).toEqual([
      'represent and/or expressions',
      'bound the memory of loop guards',
      'subscripted callees',
      'parser design notes',
    ]);
  });

  test('changed files are grouped by folder, two levels inside containers like crates/', () => {
    expect(w.filesChanged).toBe(34);
    expect(w.topFolders).toEqual([
      { path: 'crates/parser', files: 24 },
      { path: 'crates/lexer', files: 9 },
      { path: 'docs', files: 1 },
    ]);
  });

  test('an undescriptive branch (feat/m2) gives way to the recurring commit scope', () => {
    // lexer has one commit only; a one-word topic gets the newest subject
    expect(w.workingOn).toBe('working on parser: parser design notes');
  });
});

describe('Python, medium: one afternoon, one commit', () => {
  const root = '/w/svc';
  const events = [
    ev(
      root,
      '2026-10-20T10:00:00.000Z',
      'user_prompt',
      'Make the client retry on timeouts, with backoff.',
    ),
    ...every10('2026-10-20T10:05:00.000Z', 9, (ts, i) =>
      edit(root, ts, i % 3 ? `src/svc/client${i}.py` : `tests/test_client${i}.py`),
    ),
    ev(root, '2026-10-20T11:40:00.000Z', 'commit', 'Retry on timeouts'),
  ];
  const w = summarizeWork(events, { root, branch: 'fix/issue-42-retry-timeouts', gapMinutes: 45 });

  test('medium, with the descriptive branch in words', () => {
    expect(w.size).toBe('medium');
    expect(w.activeMinutes).toBe(100);
    expect(w.workingOn).toBe('fixing issue #42: retry timeouts');
    expect(w.topFolders).toEqual([
      { path: 'src/svc', files: 6 },
      { path: 'tests', files: 3 },
    ]);
  });
});

describe('JS, small: a quarter of an hour, no commit', () => {
  const root = '/w/web';
  const events = [
    ev(root, '2026-10-20T10:00:00.000Z', 'user_prompt', '<task-notification><task-id>x</task-id>'),
    ev(root, '2026-10-20T10:01:00.000Z', 'user_prompt', 'ok continue'),
    ev(
      root,
      '2026-10-20T10:02:00.000Z',
      'user_prompt',
      'Rename the submit button to Save. Thanks!',
    ),
    edit(root, '2026-10-20T10:10:00.000Z', 'src/components/Form.jsx'),
    ev(root, '2026-10-20T10:15:00.000Z', 'agent_message', 'Renamed it.'),
  ];
  const w = summarizeWork(events, { root, branch: 'main', gapMinutes: 45 });

  test('small; the first substantive request says what it was about', () => {
    expect(w.size).toBe('small');
    expect(w.activeMinutes).toBe(15);
    expect(w.commits).toEqual([]);
    expect(w.workingOn).toBe('working on: Rename the submit button to Save.');
  });
});

test('without branch words, commits or requests, the folders say where the work was', () => {
  const root = '/w/app';
  const events = every10('2026-10-20T10:00:00.000Z', 4, (ts, i) =>
    edit(root, ts, `apps/server/f${i}.ts`),
  );
  expect(summarizeWork(events, { root, branch: 'main', gapMinutes: 45 }).workingOn).toBe(
    'working in apps/server',
  );
});

test('commit file lists count as changed files; files outside the project do not', () => {
  const root = '/w/app';
  const events = [
    ev(root, '2026-10-20T10:00:00.000Z', 'commit', 'Add retries', {
      files: ['lib/a.rb', 'lib/b.rb'],
    }),
    ev(root, '2026-10-20T10:05:00.000Z', 'file_edit', 'Edited x', {
      path: '/home/u/.claude/notes.md',
    }),
  ];
  const w = summarizeWork(events, { root, branch: null, gapMinutes: 45 });
  expect(w.filesChanged).toBe(2);
  expect(w.topFolders).toEqual([{ path: 'lib', files: 2 }]);
});

test.each([
  ['feature/forgot-password', 'building forgot password'],
  ['feat/user-onboarding-flow', 'building user onboarding flow'],
  ['fix/issue-15-s3vectors-error-mapping', 'fixing issue #15: s3vectors error mapping'],
  ['bugfix/PROJ-123-null-cart-total', 'fixing PROJ-123: null cart total'],
  ['refactor/auth-middleware', 'refactoring auth middleware'],
  ['docs/install-guide', 'writing docs: install guide'],
  ['dark-mode-toggle', 'working on dark mode toggle'],
  ['feat/m0-m1', null],
  ['main', null],
  ['master', null],
  ['develop', null],
  ['detached@abc1234', null],
  ['wip', null],
])('branchPhrase(%j) → %j', (branch, phrase) => {
  expect(branchPhrase(branch)).toBe(phrase);
});

test('commits without scopes: the first subject, quoted after a colon', () => {
  const root = '/w/app';
  const events = [
    ev(root, '2026-10-20T10:00:00.000Z', 'commit', 'feat: human-readable briefs'),
    ev(root, '2026-10-20T10:30:00.000Z', 'commit', 'test: end-to-end scenario'),
  ];
  expect(summarizeWork(events, { root, branch: 'main', gapMinutes: 45 }).workingOn).toBe(
    'working on: human-readable briefs',
  );
});

// ---- real-data fixes (owner proof run) ----

test('a session across midnight is one day', () => {
  const root = '/w/app';
  const events = [
    ev(root, '2026-10-20T23:50:00.000Z', 'user_prompt', 'Add the export button to the toolbar.'),
    ev(root, '2026-10-21T00:20:00.000Z', 'agent_message', 'Added.'),
  ];
  expect(summarizeWork(events, { root, branch: null, gapMinutes: 45 }).days).toBe(1);
});

test('hidden folders (.github, .superpowers, …) are not where the work was', () => {
  const root = '/w/app';
  const events = [
    edit(root, '2026-10-20T10:00:00.000Z', '.superpowers/plans/a.md'),
    edit(root, '2026-10-20T10:01:00.000Z', '.superpowers/plans/b.md'),
    edit(root, '2026-10-20T10:02:00.000Z', 'src/api/a.ts'),
  ];
  const w = summarizeWork(events, { root, branch: null, gapMinutes: 45 });
  expect(w.topFolders).toEqual([{ path: 'src/api', files: 1 }]);
  expect(w.filesChanged).toBe(1);
});

test('commit scopes say what it was about only when they recur; else the first subject', () => {
  const root = '/w/app';
  const commits = (subjects: string[]) =>
    summarizeWork(
      subjects.map((s, i) => ev(root, `2026-10-20T10:0${i}:00.000Z`, 'commit', s)),
      { root, branch: 'main', gapMinutes: 45 },
    ).workingOn;
  expect(
    commits([
      'feat(brief): human-readable briefs',
      'test: e2e',
      'chore: dogfooding',
      'docs(dogfood): notes',
    ]),
  ).toBe('working on: human-readable briefs');
  expect(
    commits([
      'feat(semantic): a',
      'fix(semantic): b',
      'feat(kb): c',
      'feat(kb): d',
      'feat(adapters): e',
    ]),
  ).toBe('working on semantic and kb: e');
});

test('hedges and musings are not requests', () => {
  const root = '/w/app';
  const prompts = [
    'I guess we have not done much of the work yet. So do you want the old repo?',
    'I mean, I need a full project. Why did it stop?',
    'Build the login page with email and password.',
  ];
  const events = prompts.map((p, i) => ev(root, `2026-10-20T10:0${i}:00.000Z`, 'user_prompt', p));
  expect(summarizeWork(events, { root, branch: 'main', gapMinutes: 45 }).workingOn).toBe(
    'working on: Build the login page with email and password.',
  );
});

test('a day of work ends at an idle break of 8 hours or more, wherever midnight falls', () => {
  const root = '/w/app';
  const at = (ts: string) => ev(root, ts, 'agent_message', 'step');
  const days = (ts: string[]) =>
    summarizeWork(ts.map(at), { root, branch: null, gapMinutes: 45 }).days;
  expect(days(['2026-10-20T02:30:00.000Z', '2026-10-20T04:00:00.000Z'])).toBe(1); // across 4 am
  expect(days(['2026-10-20T20:00:00.000Z', '2026-10-21T03:00:00.000Z'])).toBe(1); // a long night
  expect(days(['2026-10-20T10:00:00.000Z', '2026-10-20T19:00:00.000Z'])).toBe(1); // same date
  expect(days(['2026-10-20T10:00:00.000Z', '2026-10-21T09:00:00.000Z'])).toBe(2); // next morning
});

test('the folder fallback skips the project root', () => {
  const root = '/w/app';
  const events = [
    edit(root, '2026-10-20T10:00:00.000Z', 'a.md'),
    edit(root, '2026-10-20T10:01:00.000Z', 'b.md'),
    edit(root, '2026-10-20T10:02:00.000Z', 'docs/c.md'),
  ];
  expect(summarizeWork(events, { root, branch: 'main', gapMinutes: 45 }).workingOn).toBe(
    'working in docs',
  );
});

test('short but with several commits, or spread over two days, is not small', () => {
  const root = '/w/app';
  const quick = [
    ev(root, '2026-10-20T10:00:00.000Z', 'commit', 'one'),
    ev(root, '2026-10-20T10:10:00.000Z', 'commit', 'two'),
  ];
  expect(summarizeWork(quick, { root, branch: null, gapMinutes: 45 }).size).toBe('medium');
  const twoDays = [
    ev(root, '2026-10-20T10:00:00.000Z', 'agent_message', 'a'),
    ev(root, '2026-10-21T10:00:00.000Z', 'agent_message', 'b'),
  ];
  expect(summarizeWork(twoDays, { root, branch: null, gapMinutes: 45 }).size).toBe('medium');
});

test('a topic of 3 words or more stands alone; a shorter one gets the newest commit subject', () => {
  const root = '/w/app';
  const commits = (branch: string, subjects: string[]) =>
    summarizeWork(
      subjects.map((s, i) => ev(root, `2026-10-20T10:0${i}:00.000Z`, 'commit', s)),
      { root, branch, gapMinutes: 45 },
    ).workingOn;
  expect(commits('main', ['feat(brief): a', 'feat(brief): b', 'docs: c'])).toBe(
    'working on brief: c',
  );
  expect(commits('fix/s3vectors-error-mapping', ['Map errors'])).toBe(
    'fixing s3vectors error mapping',
  );
  expect(
    commits('main', [
      'feat(semantic): a',
      'feat(semantic): b',
      'feat(kb): c',
      'feat(kb): d',
      'fix(adapters): e',
      'fix(adapters): f',
    ]),
  ).toBe('working on semantic, kb and adapters');
  expect(commits('feature/forgot-password', [])).toBe('building forgot password'); // no commit to add
});

test('no commits: the README says what the project is, then where most changes were', () => {
  const root = '/w/quillmark';
  const events = [
    ev(root, '2026-10-20T10:00:00.000Z', 'user_prompt', 'I guess it is mostly done?'),
    edit(root, '2026-10-20T10:01:00.000Z', 'docs/a.md'),
    edit(root, '2026-10-20T10:02:00.000Z', 'docs/b.md'),
    edit(root, '2026-10-20T10:03:00.000Z', 'tests/c.py'),
    edit(root, '2026-10-20T10:04:00.000Z', 'main.py'),
  ];
  const about = 'a small local notes app';
  expect(summarizeWork(events, { root, branch: 'main', gapMinutes: 45, about }).workingOn).toBe(
    'working on quillmark (a small local notes app): mostly docs and tests',
  );
  // commits still come first
  const withCommit = [
    ...events,
    ev(root, '2026-10-20T10:05:00.000Z', 'commit', 'Add sync settings page'),
  ];
  expect(summarizeWork(withCommit, { root, branch: 'main', gapMinutes: 45, about }).workingOn).toBe(
    'working on: Add sync settings page',
  );
});

test("the work summary keeps the commits' hashes and files (for the diff) and how many folders changed", () => {
  const root = '/w/app';
  const events = [
    ev(root, '2026-10-20T10:00:00.000Z', 'commit', 'one', { hash: 'aaa', files: ['src/a/x.py'] }),
    ev(root, '2026-10-20T10:05:00.000Z', 'commit', 'two', {
      hash: 'bbb',
      files: ['docs/y.md', 'src/a/x.py'],
    }),
    edit(root, '2026-10-20T10:06:00.000Z', 'web/z.css'),
    edit(root, '2026-10-20T10:07:00.000Z', 'infra/w.yml'),
  ];
  const w = summarizeWork(events, { root, branch: null, gapMinutes: 45 });
  expect(w.hashes).toEqual(['aaa', 'bbb']);
  expect(w.commitFiles).toEqual(['docs/y.md', 'src/a/x.py']);
  expect(w.folderCount).toBe(4);
  const noFiles = summarizeWork(
    [ev(root, '2026-10-20T10:00:00.000Z', 'commit', 'one', { hash: 'aaa' })],
    {
      root,
      branch: null,
      gapMinutes: 45,
    },
  );
  expect(noFiles.commitFiles).toBeNull(); // a commit stored without its files: the diff isn't limited
});
