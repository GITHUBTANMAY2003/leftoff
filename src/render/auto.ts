import type { BriefFacts } from '../brief/facts.ts';
import { narrativeLines, shortPolish } from './narrative.ts';
import { LINE_WIDTH, painter } from './terminal.ts';

// The automatic brief on terminal open (spec §1.8): the narrative brief (Task
// 15b), the first two sentences of a cached polished summary first when its
// facts still match (owner decision after Task 15b), then the
// pointer to `leftoff resume`. Only the first line is bold.

export function renderAutoBrief(
  f: BriefFacts,
  opts: { color: boolean; now?: Date; polished?: string | null },
): string {
  const p = painter(opts.color);
  const polished = opts.polished ? shortPolish(opts.polished) : null;
  const [first = '', ...rest] = narrativeLines(f, polished, {
    now: opts.now ?? new Date(),
    width: LINE_WIDTH,
  });
  return [p.bold(first), ...rest, 'Run `leftoff resume` for details'].join('\n');
}
