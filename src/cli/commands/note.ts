import { dedupeKey, makeEvent } from '../../model/event.ts';
import { resolveProject } from '../../model/project.ts';
import { openDb } from '../../store/db.ts';
import { createRepo } from '../../store/repo.ts';

// `leftoff note "<text>"` (P11): a note on the current project's timeline.
// Notes always appear in the brief; one starting with "next:" sets the next step.
export async function runNote(cwd: string, text: string): Promise<void> {
  const summary = text.trim();
  if (summary === '') throw new Error('note text is empty');
  const root = resolveProject(cwd);
  const ts = new Date().toISOString();
  const db = openDb();
  try {
    createRepo(db).insertEvents([
      makeEvent({
        source: 'user',
        kind: 'note',
        projectRoot: root,
        ts,
        sessionRef: null,
        summary,
        dedupeKey: dedupeKey('note', root, ts, summary),
      }),
    ]);
  } finally {
    db.close();
  }
}
