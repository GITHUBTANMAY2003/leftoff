import type { BriefFacts } from '../brief/facts.ts';
import { compactLines, shortPolish } from './narrative.ts';
import { LINE_WIDTH, painter } from './terminal.ts';

// The automatic brief on terminal open (spec §1.8): the compact form — what
// you were working on, where it stopped, the next step — after the first two
// sentences of a cached polished summary whose facts still match (owner
// decisions after Task 15b and Task 17), then the pointer to `leftoff resume`
// for the full story. Only the first line is bold.

export function renderAutoBrief(
  f: BriefFacts,
  opts: { color: boolean; now?: Date; polished?: string | null },
): string {
  const p = painter(opts.color);
  const polished = opts.polished ? shortPolish(opts.polished) : null;
  const [first = '', ...rest] = compactLines(f, polished, {
    now: opts.now ?? new Date(),
    width: LINE_WIDTH,
  });
  return [p.bold(first), ...rest, 'Run `leftoff resume` for the full story'].join('\n');
}
