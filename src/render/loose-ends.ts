import {
  contradictionOf,
  type ClaimedDone,
  type LooseEnds,
  type OpenProblem,
} from '../brief/facts.ts';
import { agentName } from '../brief/next-step.ts';
import { relativeAgo } from '../core/time.ts';
import { youWereLine } from './narrative.ts';
import { fit, fitKeepingTail, LINE_WIDTH, painter } from './terminal.ts';
import { clipMiddle, plural } from './text.ts';

// `leftoff` / `leftoff loops` (spec §1.8): at most three lines per project —
// when you last worked on it (with a done-claim and flags), what you were
// working on, and the next step with what else is open (owner request after
// Task 17 started). Lines are cut to the terminal width, keeping their ends.

const INDENT = '  ';
const MAX_WHERE_CHARS = 32;

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

// What is open besides what the claim and the next step already say.
function alsoOpen(item: LooseEnds): string[] {
  const claimed = new Set(item.claimedDone?.contradictions ?? []);
  const unclaimed = item.openProblems.filter((p) => !claimed.has(contradictionOf(p)));
  // The next step is about the first problem when there is no claim.
  const more = unclaimed.length - (item.claimedDone ? 0 : Math.min(unclaimed.length, 1));
  const filesSaid =
    /uncommitted/.test([...claimed].join(' ')) || /^Review and commit/.test(item.nextStep ?? '');
  return [
    ...(more > 0 ? [`${more} more ${more === 1 ? 'problem' : 'problems'}`] : []),
    ...(item.uncommittedCount > 0 && !filesSaid
      ? [plural(item.uncommittedCount, 'uncommitted file')]
      : []),
  ];
}

export function renderLooseEnds(items: LooseEnds[], now: Date, opts: { color: boolean }): string {
  if (items.length === 0) return 'No loose ends. Everything is committed and passing.';
  const p = painter(opts.color);

  const blocks = items.map((item) => {
    const where = item.branch ? `${item.project.name} (${item.branch})` : item.project.name;
    const flags = [
      ...(item.claimedDone
        ? [
            `${agentName(item.claimedDone.source)} said done, ${claimSummary(item.claimedDone, item.openProblems)}`,
          ]
        : []),
      ...(item.stale ? ['stale'] : []),
      ...(item.gitUnavailable ? ['git status unavailable'] : []),
    ];
    const tail = [`last worked ${relativeAgo(item.lastActiveAt, now)}`, ...flags]
      .map((x) => ` · ${x}`)
      .join('');
    // The name and branch stay (shortened only past 32 characters); the flags
    // are cut at the end when the line is too long.
    const out = [p.bold(fit('', `${clipMiddle(where, MAX_WHERE_CHARS)}${tail}`))];
    const youWere = youWereLine(item.workingOn, item.lastIntent);
    if (youWere) out.push(`${INDENT}${fit(INDENT, youWere)}`);
    if (item.nextStep) {
      const also = alsoOpen(item);
      let next = `Next: ${item.nextStep}`;
      const room =
        LINE_WIDTH -
        [...INDENT].length -
        (also.length > 0 ? [...` (also: ${also.join(', ')})`].length : 1);
      // Too long: the trailing bracket (the command, or the error) goes first,
      // so no cut lands inside it.
      if ([...next].length > room) next = next.replace(/ \([^()]*\)$/, '');
      out.push(
        also.length > 0
          ? `${INDENT}${fitKeepingTail(INDENT, next, ` (also: ${also.join(', ')})`)}`
          : `${INDENT}${fit(INDENT, /[.!?…]$/.test(next) ? next : `${next}.`)}`,
      );
    }
    return out.join('\n');
  });
  const n = items.length;
  return [
    p.bold(`Loose ends across ${plural(n, 'project')}`),
    blocks.join('\n'),
    'Run `leftoff resume` inside a project for details',
  ].join('\n\n');
}
