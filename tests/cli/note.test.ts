import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { runNote } from '../../src/cli/commands/note.ts';
import { ensureHome } from '../../src/core/paths.ts';
import { openDb } from '../../src/store/db.ts';
import { createRepo } from '../../src/store/repo.ts';

let tmp: string;
let project: string;
const savedHome = process.env.LEFTOFF_HOME;

beforeEach(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), 'leftoff-note-')));
  process.env.LEFTOFF_HOME = join(tmp, 'lhome');
  ensureHome();
  project = join(tmp, 'app');
  mkdirSync(join(project, 'src'), { recursive: true });
});

afterEach(() => {
  if (savedHome === undefined) delete process.env.LEFTOFF_HOME;
  else process.env.LEFTOFF_HOME = savedHome;
  rmSync(tmp, { recursive: true, force: true });
});

const notes = () => {
  const db = openDb();
  try {
    return createRepo(db).eventsSince('2000-01-01T00:00:00.000Z');
  } finally {
    db.close();
  }
};

test('runNote stores a user note for the current project', async () => {
  await runNote(project, 'remember to rotate the SMTP password');
  const [e] = notes();
  expect(e).toMatchObject({
    source: 'user',
    kind: 'note',
    projectRoot: project,
    summary: 'remember to rotate the SMTP password',
    sessionRef: null,
  });
});

test('the project is resolved from a subfolder (non-git: the folder itself)', async () => {
  await runNote(join(project, 'src'), 'from src');
  expect(notes()[0]?.projectRoot).toBe(join(project, 'src'));
});

test('two identical notes at different times are both kept', async () => {
  await runNote(project, 'same text');
  await new Promise((r) => setTimeout(r, 5));
  await runNote(project, 'same text');
  expect(notes()).toHaveLength(2);
});

test('notes are redacted like everything else', async () => {
  await runNote(project, 'staging key is GH_TOKEN=abc123');
  expect(notes()[0]?.summary).toBe('staging key is GH_TOKEN=[REDACTED]');
});

test('an empty note is refused', async () => {
  await expect(runNote(project, '   ')).rejects.toThrow(/empty/);
  expect(notes()).toEqual([]);
});
