import pkg from '../../../package.json' with { type: 'json' };
import { relativeAgo } from '../../core/time.ts';
import { paths } from '../../core/paths.ts';
import { openDb } from '../../store/db.ts';
import { createRepo } from '../../store/repo.ts';
import type { IngestReport } from '../../ingest/ingest.ts';
import { basename } from 'node:path';
import { plural } from '../../render/text.ts';

// `leftoff status` (§1.10): tracked projects, the last ingest per collector,
// event counts.
const MAX_PROJECTS = 10;
const MARK = { ok: '✓', not_found: '–', error: '!' } as const;
const ORDER = ['claude', 'git', 'shell', 'codex'] as const;

export async function runStatus(deps: { now?: Date } = {}): Promise<string> {
  const now = deps.now ?? new Date();
  const db = openDb();
  try {
    const repo = createRepo(db);
    const lines = [`leftoff ${pkg.version} — data in ${paths().home}`, ''];
    const projects = repo.projects();
    if (projects.length === 0) {
      lines.push('No projects tracked yet.');
    } else {
      const total = projects.reduce((n, p) => n + p.count, 0);
      lines.push(`Projects: ${projects.length} tracked, ${total} events`);
      for (const p of projects.slice(0, MAX_PROJECTS)) {
        lines.push(
          `  ${basename(p.root)} · last active ${relativeAgo(p.lastTs, now)} · ${plural(p.count, 'event')}`,
        );
      }
      if (projects.length > MAX_PROJECTS) lines.push(`  +${projects.length - MAX_PROJECTS} more`);
    }
    lines.push('');
    const raw = repo.getCursor('ingest', 'last_report');
    if (raw === null) {
      lines.push('No ingest has run yet. Run `leftoff setup`.');
    } else {
      const report = JSON.parse(raw) as IngestReport & { at: string };
      lines.push(`Last ingest: ${relativeAgo(report.at, now)}`);
      for (const name of ORDER) {
        const s = report.perSource[name];
        if (!s) continue;
        const what =
          s.status === 'ok'
            ? plural(s.inserted, 'new event')
            : (s.detail ?? (s.status === 'not_found' ? 'not found' : 'failed'));
        lines.push(`  ${name} ${MARK[s.status]} ${what}`);
      }
    }
    return lines.join('\n');
  } finally {
    db.close();
  }
}
