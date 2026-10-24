import type { Database } from 'better-sqlite3';
import type { EventKind, Source, WorkEvent } from '../model/event.ts';

export interface StoredBrief {
  factsHash: string;
  polished: string | null;
  provider: string | null;
  createdAt: string;
}

// Storage interface (D9): everything above the store talks to this, not to SQLite.
export interface Repo {
  insertEvents(events: WorkEvent[]): number;
  eventsForProject(root: string, sinceIso: string): WorkEvent[];
  eventsSince(sinceIso: string): WorkEvent[];
  projects(): { root: string; lastTs: string; count: number }[];
  lastActivity(root: string): string | null;
  getCursor(collector: string, key: string): string | null;
  setCursor(collector: string, key: string, value: string): void;
  saveBrief(
    root: string,
    factsHash: string,
    factsJson: string,
    polished: string | null,
    provider: string | null,
  ): void;
  getBrief(root: string): StoredBrief | null;
  markBriefShown(root: string, activityIso: string): void;
  briefShownFor(root: string): string | null;
  acquireLock(name: string, holder: string, ttlMs: number): boolean;
  releaseLock(name: string, holder: string): void;
  pruneOlderThan(iso: string): number;
  deleteProject(root: string): void;
  deleteAll(): void;
}

interface EventRow {
  source: string;
  kind: string;
  project_root: string;
  ts: string;
  session_ref: string | null;
  summary: string;
  data: string;
  dedupe_key: string;
}

const EVENT_COLUMNS = 'source, kind, project_root, ts, session_ref, summary, data, dedupe_key';

function toEvent(row: EventRow): WorkEvent {
  return {
    source: row.source as Source,
    kind: row.kind as EventKind,
    projectRoot: row.project_root,
    ts: row.ts,
    sessionRef: row.session_ref,
    summary: row.summary,
    data: JSON.parse(row.data) as Record<string, unknown>,
    dedupeKey: row.dedupe_key,
  };
}

const now = () => new Date().toISOString();

export function createRepo(db: Database): Repo {
  // ON CONFLICT(dedupe_key) ignores duplicates only. INSERT OR IGNORE would
  // also silently drop rows that break NOT NULL, hiding a broken collector.
  const insertEvent = db.prepare(
    `INSERT INTO events(${EVENT_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(dedupe_key) DO NOTHING`,
  );
  const insertAll = db.transaction((events: WorkEvent[]) => {
    let inserted = 0;
    for (const e of events) {
      const info = insertEvent.run(
        e.source,
        e.kind,
        e.projectRoot,
        e.ts,
        e.sessionRef,
        e.summary,
        JSON.stringify(e.data),
        e.dedupeKey,
      );
      inserted += info.changes;
    }
    return inserted;
  });
  const forProject = db.prepare<[string, string], EventRow>(
    `SELECT ${EVENT_COLUMNS} FROM events WHERE project_root = ? AND ts >= ? ORDER BY ts, id`,
  );
  const since = db.prepare<[string], EventRow>(
    `SELECT ${EVENT_COLUMNS} FROM events WHERE ts >= ? ORDER BY ts, id`,
  );
  const projects = db.prepare<[], { root: string; lastTs: string; count: number }>(
    `SELECT project_root AS root, MAX(ts) AS lastTs, COUNT(*) AS count
     FROM events GROUP BY project_root ORDER BY lastTs DESC`,
  );
  const lastActivity = db.prepare<[string], { ts: string | null }>(
    'SELECT MAX(ts) AS ts FROM events WHERE project_root = ?',
  );
  const getCursor = db.prepare<[string, string], { value: string }>(
    'SELECT value FROM cursors WHERE collector = ? AND key = ?',
  );
  const setCursor = db.prepare(
    `INSERT INTO cursors(collector, key, value, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(collector, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  );
  const saveBrief = db.prepare(
    `INSERT OR REPLACE INTO briefs(project_root, facts_hash, facts_json, polished, polish_provider, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );
  const getBrief = db.prepare<[string], StoredBrief>(
    `SELECT facts_hash AS factsHash, polished, polish_provider AS provider, created_at AS createdAt
     FROM briefs WHERE project_root = ?`,
  );
  const markShown = db.prepare(
    'INSERT OR REPLACE INTO brief_views(project_root, last_shown_at, activity_seen) VALUES (?, ?, ?)',
  );
  const shownFor = db.prepare<[string], { activity_seen: string | null }>(
    'SELECT activity_seen FROM brief_views WHERE project_root = ?',
  );
  // One statement, so taking the lock is atomic across processes. Succeeds when
  // the lock is free, expired, or already held by the same holder (renewal).
  const acquireLock = db.prepare(
    `INSERT INTO locks(name, holder, expires_at) VALUES (?, ?, ?)
     ON CONFLICT(name) DO UPDATE SET holder = excluded.holder, expires_at = excluded.expires_at
     WHERE locks.expires_at <= ? OR locks.holder = excluded.holder`,
  );
  const releaseLock = db.prepare('DELETE FROM locks WHERE name = ? AND holder = ?');
  const prune = db.prepare('DELETE FROM events WHERE ts < ?');
  const deleteProject = db.transaction((root: string) => {
    for (const table of ['events', 'briefs', 'brief_views']) {
      db.prepare(`DELETE FROM ${table} WHERE project_root = ?`).run(root);
    }
  });
  // Cursors are kept on purpose: deleting them would make the next ingest
  // re-import the history the user just asked to forget.
  const deleteAll = db.transaction(() => {
    for (const table of ['events', 'briefs', 'brief_views', 'locks']) {
      db.prepare(`DELETE FROM ${table}`).run();
    }
  });

  return {
    insertEvents: (events) => insertAll(events),
    eventsForProject: (root, sinceIso) => forProject.all(root, sinceIso).map(toEvent),
    eventsSince: (sinceIso) => since.all(sinceIso).map(toEvent),
    projects: () => projects.all(),
    lastActivity: (root) => lastActivity.get(root)?.ts ?? null,
    getCursor: (collector, key) => getCursor.get(collector, key)?.value ?? null,
    setCursor: (collector, key, value) => {
      setCursor.run(collector, key, value, now());
    },
    saveBrief: (root, factsHash, factsJson, polished, provider) => {
      saveBrief.run(root, factsHash, factsJson, polished, provider, now());
    },
    getBrief: (root) => getBrief.get(root) ?? null,
    markBriefShown: (root, activityIso) => {
      markShown.run(root, now(), activityIso);
    },
    briefShownFor: (root) => shownFor.get(root)?.activity_seen ?? null,
    acquireLock: (name, holder, ttlMs) => {
      const t = Date.now();
      const expires = new Date(t + ttlMs).toISOString();
      return acquireLock.run(name, holder, expires, new Date(t).toISOString()).changes === 1;
    },
    releaseLock: (name, holder) => {
      releaseLock.run(name, holder);
    },
    pruneOlderThan: (iso) => prune.run(iso).changes,
    deleteProject: (root) => deleteProject(root),
    deleteAll: () => deleteAll(),
  };
}
