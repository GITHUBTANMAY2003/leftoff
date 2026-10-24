// Child process for the concurrency test in db.test.ts. Run directly by Node
// (built-in type stripping): node concurrent-writer.ts <dbFile> <writerId> <count>
import { openDb } from '../../src/store/db.ts';
import { createRepo } from '../../src/store/repo.ts';

const [file, writerId, count] = process.argv.slice(2);
const repo = createRepo(openDb(file));
for (let i = 0; i < Number(count); i++) {
  // One small transaction per event, to maximize lock contention.
  repo.insertEvents([
    {
      source: 'shell',
      kind: 'command',
      projectRoot: '/p',
      ts: new Date().toISOString(),
      sessionRef: `shell:${writerId}`,
      summary: `writer ${writerId} event ${i}`,
      data: {},
      dedupeKey: `${writerId}-${i}`,
    },
  ]);
}
