import type { Database } from 'better-sqlite3';

// MIGRATIONS[i] upgrades the schema from version i to i + 1 (PRAGMA user_version).
// Never edit a released entry; append a new one.
export const MIGRATIONS: string[] = [
  `
  CREATE TABLE events(id INTEGER PRIMARY KEY, source TEXT NOT NULL, kind TEXT NOT NULL,
    project_root TEXT NOT NULL, ts TEXT NOT NULL, session_ref TEXT, summary TEXT NOT NULL,
    data TEXT NOT NULL, dedupe_key TEXT NOT NULL UNIQUE);
  CREATE INDEX events_project_ts ON events(project_root, ts);
  CREATE TABLE cursors(collector TEXT, key TEXT, value TEXT NOT NULL, updated_at TEXT NOT NULL,
    PRIMARY KEY(collector, key));
  CREATE TABLE briefs(project_root TEXT PRIMARY KEY, facts_hash TEXT, facts_json TEXT,
    polished TEXT, polish_provider TEXT, created_at TEXT);
  CREATE TABLE brief_views(project_root TEXT PRIMARY KEY, last_shown_at TEXT, activity_seen TEXT);
  CREATE TABLE locks(name TEXT PRIMARY KEY, holder TEXT NOT NULL, expires_at TEXT NOT NULL);
  `,
];

export class SchemaTooNewError extends Error {}

export function migrate(db: Database): void {
  const version = () => db.pragma('user_version', { simple: true }) as number;
  if (version() > MIGRATIONS.length) {
    throw new SchemaTooNewError(
      `database schema v${version()} is newer than this leftoff supports (v${MIGRATIONS.length}); upgrade leftoff`,
    );
  }
  // IMMEDIATE takes the write lock first, so two processes opening a new file
  // can't both apply the same migration; the version is re-read under the lock.
  db.transaction(() => {
    for (let v = version(); v < MIGRATIONS.length; v++) {
      db.exec(MIGRATIONS[v] as string);
      db.pragma(`user_version = ${v + 1}`);
    }
  }).immediate();
}
