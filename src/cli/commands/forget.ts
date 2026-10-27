import { basename } from 'node:path';
import { resolveProject } from '../../model/project.ts';
import { openDb } from '../../store/db.ts';
import { createRepo } from '../../store/repo.ts';
import { plural } from '../../render/text.ts';
import type { Prompter } from '../prompter.ts';

// `leftoff forget (--project <path> | --all) [--yes]` (§1.10).
export const KEPT_NOTE =
  'Read positions (file paths and offsets, no content) are kept, so forgotten history is not read in again.';

export async function runForget(
  opts: { project?: string; all: boolean; yes: boolean },
  io: Prompter,
): Promise<string> {
  if (opts.project !== undefined && opts.all) return 'Use --project <path> or --all, not both.';
  if (opts.project === undefined && !opts.all) return 'Use --project <path> or --all.';
  const db = openDb();
  try {
    const repo = createRepo(db);
    if (opts.all) {
      const count = repo.countEvents();
      if (
        !opts.yes &&
        !(await io.confirm(`Delete all stored data (${plural(count, 'event')})?`, false))
      ) {
        return 'Nothing deleted.';
      }
      repo.deleteAll();
      return `Forgot all stored data (${plural(count, 'event')}).\n${KEPT_NOTE}`;
    }
    const root = resolveProject(opts.project as string);
    const count = repo.countEvents(root);
    if (count === 0) return `No data stored for ${opts.project}.`;
    if (
      !opts.yes &&
      !(await io.confirm(`Delete ${plural(count, 'event')} stored for ${root}?`, false))
    ) {
      return 'Nothing deleted.';
    }
    repo.deleteProject(root);
    return `Forgot ${plural(count, 'event')} for ${basename(root)}.\n${KEPT_NOTE}`;
  } finally {
    db.close();
  }
}
