import type { BriefFacts } from '../brief/facts.ts';
import { narrativeLines } from './narrative.ts';
import { LINE_WIDTH, painter } from './terminal.ts';

// The automatic brief on terminal open (spec §1.8): the narrative brief (Task
// 15b), a cached polished summary first when its facts still match, then the
// pointer to `leftoff resume`. Only the first line is bold.

export function renderAutoBrief(
  f: BriefFacts,
  opts: { color: boolean; now?: Date; polished?: string | null },
): string {
  const p = painter(opts.color);
  const [first = '', ...rest] = narrativeLines(f, opts.polished ?? null, {
    now: opts.now ?? new Date(),
    width: LINE_WIDTH,
  });
  return [p.bold(first), ...rest, 'Run `leftoff resume` for details'].join('\n');
}
