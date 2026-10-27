import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { expect, test } from 'vitest';
import { runForget } from '../../src/cli/commands/forget.ts';
import { openDb } from '../../src/store/db.ts';
import { createRepo, type Repo } from '../../src/store/repo.ts';
import { scripted } from '../helpers/prompter.ts';
import { useTempHome } from '../helpers/home.ts';
import { ev } from '../store/helpers.ts';

useTempHome();

function withRepo<T>(fn: (repo: Repo) => T): T {
  const db = openDb();
  try {
    return fn(createRepo(db));
  } finally {
    db.close();
  }
}
const seed = () =>
  withRepo((repo) => {
    repo.insertEvents([
      ev('a1', { projectRoot: '/w/a' }),
      ev('a2', { projectRoot: '/w/a' }),
      ev('b1', { projectRoot: '/w/b' }),
    ]);
    repo.markBriefShown('/w/a', '2026-10-20T10:00:00.000Z');
    repo.setCursor('claude', '/x/session.jsonl', '{"offset":42}');
  });
const KEPT = /Read positions \(file paths and offsets, no content\) are kept/;

test('forget --project removes only that project, after confirming', async () => {
  seed();
  const { io, asked } = scripted([true]);
  const out = await runForget({ project: '/w/a', all: false, yes: false }, io);
  expect(asked).toHaveLength(1);
  expect(asked[0]).toContain('/w/a');
  expect(out).toContain('Forgot 2 events for a');
  expect(out).toMatch(KEPT);
  withRepo((repo) => {
    expect(repo.countEvents('/w/a')).toBe(0);
    expect(repo.countEvents('/w/b')).toBe(1);
    expect(repo.briefShownFor('/w/a')).toBeNull();
    expect(repo.getCursor('claude', '/x/session.jsonl')).toBe('{"offset":42}'); // kept
  });
});

test('forget --all removes everything; --yes skips the question', async () => {
  seed();
  const { io, asked } = scripted();
  const out = await runForget({ all: true, yes: true }, io);
  expect(asked).toEqual([]);
  expect(out).toContain('Forgot all stored data (3 events)');
  expect(out).toMatch(KEPT);
  withRepo((repo) => {
    expect(repo.countEvents()).toBe(0);
    expect(repo.getCursor('claude', '/x/session.jsonl')).toBe('{"offset":42}');
  });
});

test('declining the question deletes nothing', async () => {
  seed();
  const { io } = scripted([false]);
  expect(await runForget({ all: true, yes: false }, io)).toBe('Nothing deleted.');
  withRepo((repo) => expect(repo.countEvents()).toBe(3));
});

test('forget needs --project or --all, and not both; an unknown project says so', async () => {
  seed();
  const { io } = scripted();
  expect(await runForget({ all: false, yes: true }, io)).toMatch(/--project <path> or --all/);
  expect(await runForget({ project: '/w/a', all: true, yes: true }, io)).toMatch(/not both/);
  expect(await runForget({ project: '/w/zzz', all: false, yes: true }, io)).toBe(
    'No data stored for /w/zzz.',
  );
  withRepo((repo) => expect(repo.countEvents()).toBe(3));
});

test('`leftoff forget --help` says that read positions are kept', () => {
  const cli = resolve(import.meta.dirname, '../../src/cli/index.ts');
  const r = spawnSync(process.execPath, [cli, 'forget', '--help'], {
    env: process.env,
    encoding: 'utf8',
  });
  expect(r.stdout.replace(/\s+/g, ' ')).toMatch(/read positions \(file paths and offsets/i);
});
