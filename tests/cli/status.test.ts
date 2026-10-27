import { expect, test } from 'vitest';
import { runStatus } from '../../src/cli/commands/status.ts';
import { openDb } from '../../src/store/db.ts';
import { createRepo, type Repo } from '../../src/store/repo.ts';
import { ev } from '../store/helpers.ts';
import { useTempHome } from '../helpers/home.ts';

useTempHome();
const NOW = new Date('2026-10-28T12:00:00.000Z');

function withRepo<T>(fn: (repo: Repo) => T): T {
  const db = openDb();
  try {
    return fn(createRepo(db));
  } finally {
    db.close();
  }
}

test('status with nothing stored says so and points at setup', async () => {
  const out = await runStatus({ now: NOW });
  expect(out).toMatch(/^leftoff \d+\.\d+\.\d+ — data in .*\.leftoff$/m);
  expect(out).toContain('No projects tracked yet.');
  expect(out).toContain('No ingest has run yet. Run `leftoff setup`.');
});

test('status lists projects newest first with event counts, and the last ingest per collector', async () => {
  withRepo((repo) => {
    repo.insertEvents([
      ev('1', { projectRoot: '/w/old', ts: '2026-10-25T10:00:00.000Z' }),
      ev('2', { projectRoot: '/w/app', ts: '2026-10-28T09:00:00.000Z' }),
      ev('3', { projectRoot: '/w/app', ts: '2026-10-28T09:05:00.000Z' }),
    ]);
    repo.setCursor(
      'ingest',
      'last_report',
      JSON.stringify({
        at: '2026-10-28T11:00:00.000Z',
        prunedEvents: 0,
        perSource: {
          claude: { status: 'ok', inserted: 12, warnings: [] },
          git: { status: 'ok', inserted: 3, warnings: [] },
          shell: { status: 'error', inserted: 0, warnings: [], detail: 'timed out' },
          codex: { status: 'not_found', inserted: 0, warnings: [] },
        },
      }),
    );
  });
  const lines = (await runStatus({ now: NOW })).split('\n');
  expect(lines).toContain('Projects: 2 tracked, 3 events');
  const app = lines.findIndex((l) => l.includes('app · last active 2h ago · 2 events'));
  const old = lines.findIndex((l) => l.includes('old · last active 3d ago · 1 event'));
  expect(app).toBeGreaterThan(-1);
  expect(old).toBeGreaterThan(app);
  expect(lines).toContain('Last ingest: 1h ago');
  expect(lines).toContain('  claude ✓ 12 new events');
  expect(lines).toContain('  git ✓ 3 new events');
  expect(lines).toContain('  shell ! timed out');
  expect(lines).toContain('  codex – not found');
});

test('status caps the project list and says how many more', async () => {
  withRepo((repo) =>
    repo.insertEvents(
      Array.from({ length: 12 }, (_, i) =>
        ev(`p${i}`, {
          projectRoot: `/w/p${i}`,
          ts: new Date(NOW.getTime() - i * 3_600_000).toISOString(),
        }),
      ),
    ),
  );
  const out = await runStatus({ now: NOW });
  expect(out).toContain('Projects: 12 tracked, 12 events');
  expect(out).toContain('  +2 more');
  expect(out).not.toContain('/w/p11');
});
