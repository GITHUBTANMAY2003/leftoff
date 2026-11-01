import type { LooseEnds } from '../brief/facts.ts';
import { groupProblems } from '../brief/groups.ts';
import { agentName } from '../brief/next-step.ts';
import { relativeAgo } from '../core/time.ts';
import { youWereLine } from './narrative.ts';
import { fit, LINE_WIDTH, painter } from './terminal.ts';
import { plural } from './text.ts';

// `leftoff` / `leftoff loops` (spec §1.8): per project, when you last worked
// on it with its status, what you were working on, and the next step (owner
// requests after Task 17 started). The name, branch and status are never cut
// (owner decision after Task 15d): a header too long for one line puts the
// branch on its own line. Problems are counted as groups, the same number as
// `leftoff resume --details`.

const INDENT = '  ';

function status(item: LooseEnds): string[] {
  const groups = groupProblems(item.openProblems).length;
  return [
    ...(item.claimedDone ? [`${agentName(item.claimedDone.source)} said done`] : []),
    ...(groups > 0 ? [`${plural(groups, 'problem')} open`] : []),
    ...(item.uncommittedCount > 0 ? [plural(item.uncommittedCount, 'uncommitted file')] : []),
    ...(item.stale ? ['stale'] : []),
    ...(item.gitUnavailable ? ['git status unavailable'] : []),
  ];
}

function headerLines(item: LooseEnds, now: Date): string[] {
  const parts = [`last worked ${relativeAgo(item.lastActiveAt, now)}`, ...status(item)];
  const tail = parts.map((x) => ` · ${x}`).join('');
  const name = item.project.name;
  const full = item.branch ? `${name} (${item.branch})${tail}` : `${name}${tail}`;
  if ([...full].length <= LINE_WIDTH || !item.branch) return [full];
  return [`${name}${tail}`, `${INDENT}on branch ${item.branch}`];
}

// Splits at ", " outside brackets and backticks: the actions of a next step.
function splitOutsideBrackets(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let code = false;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '`') code = !code;
    else if (!code && c === '(') depth++;
    else if (!code && c === ')') depth--;
    else if (!code && depth === 0 && c === ',' && text[i + 1] === ' ') {
      parts.push(text.slice(start, i));
      start = i + 2;
    }
  }
  parts.push(text.slice(start));
  return parts;
}

function nextLine(next: string): string {
  let text = /[.!?…]$/.test(next) ? next : `${next}.`;
  const room = LINE_WIDTH - INDENT.length - 'Next: '.length;
  // Too long: the first action only (loose ends are the overview; the full
  // step is in `leftoff resume`).
  if ([...text].length > room) {
    const first = splitOutsideBrackets(next)[0] as string;
    text = `${[...first].length > room - 1 ? first.replace(/ \([^()]*\)$/, '') : first}.`;
  }
  return `${INDENT}${fit(INDENT, `Next: ${text}`)}`;
}

export function renderLooseEnds(items: LooseEnds[], now: Date, opts: { color: boolean }): string {
  if (items.length === 0) return 'No loose ends. Everything is committed and passing.';
  const p = painter(opts.color);
  const blocks = items.map((item) => {
    const [first = '', ...rest] = headerLines(item, now);
    const out = [p.bold(first), ...rest];
    const youWere = youWereLine(item.workingOn, item.lastIntent);
    if (youWere) out.push(`${INDENT}${fit(INDENT, youWere)}`);
    if (item.nextStep) out.push(nextLine(item.nextStep));
    return out.join('\n');
  });
  return [
    p.bold(`Loose ends across ${plural(items.length, 'project')}`),
    blocks.join('\n'),
    'Run `leftoff resume` inside a project for details',
  ].join('\n\n');
}
