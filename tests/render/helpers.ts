import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildFacts, type BriefFacts } from '../../src/brief/facts.ts';
import { DEFAULT_CONFIG, type Config } from '../../src/core/config.ts';
import { openDb } from '../../src/store/db.ts';
import { createRepo } from '../../src/store/repo.ts';
import { RAHUL_NOW, RAHUL_REPORT, RAHUL_ROOT, RAHUL_WORKING, rahulEvents } from '../brief/rahul.ts';

// The §1.1 facts, built the real way (events → buildFacts).
export function rahulFacts(): BriefFacts {
  const dir = mkdtempSync(join(tmpdir(), 'leftoff-render-'));
  const db = openDb(join(dir, 'leftoff.db'));
  try {
    const repo = createRepo(db);
    repo.insertEvents(rahulEvents());
    return buildFacts(RAHUL_ROOT, {
      repo,
      config: structuredClone(DEFAULT_CONFIG) as Config,
      report: RAHUL_REPORT,
      working: RAHUL_WORKING,
      now: RAHUL_NOW,
    });
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

export { RAHUL_NOW };
