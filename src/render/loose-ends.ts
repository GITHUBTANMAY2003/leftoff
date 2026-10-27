import {
  contradictionOf,
  problemText,
  type ClaimedDone,
  type LooseEnds,
  type OpenProblem,
} from '../brief/facts.ts';
import { relativeAgo } from '../core/time.ts';
import { fit, painter } from './terminal.ts';

// `leftoff` / `leftoff loops` (spec §1.8). Lines are cut to the terminal width
// from the middle, so the counts at the end of a line always survive.

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

// "1 test still failing", "2 problems still failing", "1 test and 1 other
// problem still failing", then " · 3 uncommitted files" (owner decision, Task 11).
function claimSummary(c: ClaimedDone, problems: OpenProblem[]): string {
  const byContradiction = new Map(problems.map((p) => [contradictionOf(p), p]));
  const failing = c.contradictions.flatMap((x) => byContradiction.get(x) ?? []);
  const rest = c.contradictions.filter((x) => !byContradiction.has(x));
  const tests = failing.filter((p) => p.isTest).length;
  const others = failing.length - tests;
  const parts: string[] = [];
  if (tests > 0 && others > 0) {
    parts.push(
      `${plural(tests, 'test')} and ${others} other ${others === 1 ? 'problem' : 'problems'} still failing`,
    );
  } else if (tests > 0) parts.push(`${plural(tests, 'test')} still failing`);
  else if (others > 0) parts.push(`${plural(others, 'problem')} still failing`);
  return [...parts, ...rest].join(' · ');
}

export function renderLooseEnds(items: LooseEnds[], now: Date, opts: { color: boolean }): string {
  if (items.length === 0) return 'No loose ends. Everything is committed and passing.';
  const p = painter(opts.color);

  const blocks = items.map((item) => {
    const where = item.branch ? `${item.project.name} (${item.branch})` : item.project.name;
    const title = [
      where,
      relativeAgo(item.lastActiveAt, now),
      ...(item.stale ? ['stale'] : []),
    ].join(' · ');
    const out = [p.bold(fit('', title))];
    if (item.claimedDone) {
      const tail = `" — ${claimSummary(item.claimedDone, item.openProblems)}`;
      const said = fit(`  ! Agent said "${tail}`, item.claimedDone.message);
      out.push(`  ${p.yellow('!')} Agent said "${said}${tail}`);
    }
    for (const o of item.openProblems) {
      const tail = o.attempts.length > 0 ? ` (${plural(o.attempts.length, 'attempt')})` : '';
      out.push(`  ${p.red('✗')} ${fit(`  ✗ ${tail}`, problemText(o))}${p.dim(tail)}`);
    }
    if (item.uncommittedCount > 0)
      out.push(`  • ${plural(item.uncommittedCount, 'uncommitted file')}`);
    if (item.gitUnavailable) out.push(`  ${p.yellow('?')} git status unavailable`);
    return out.join('\n');
  });
  const n = items.length;
  return [
    p.bold(`Loose ends across ${plural(n, 'project')}`),
    blocks.join('\n'),
    'Run `leftoff resume` inside a project for details',
  ].join('\n\n');
}
