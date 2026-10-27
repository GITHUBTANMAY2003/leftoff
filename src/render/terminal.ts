import { problemText, type BriefFacts } from '../brief/facts.ts';
import { relativeAgo } from '../core/time.ts';
import { splitProblems } from './problems.ts';
import { capItems, clip, clipMiddle } from './text.ts';

// The terminal brief (spec §1.8; the §1.1 example is the exact reference).
// Headings in this order; empty sections omitted; no footer after Sources.

// Each fact line is cut to this many characters (code points) with "…"; only
// the terminal does this (owner decision after Task 10).
export const LINE_WIDTH = 100;

export function fit(prefix: string, text: string, width = LINE_WIDTH): string {
  return clip(text, width - [...prefix].length);
}

// Lists show at most this many items, then "+N more" (owner decision after Task 13).
const MAX_ITEMS = 5;

// Cuts `text` but keeps `tail` whole after it, so an ending such as
// "(still failing)" or "(2 attempts)" always survives (owner decision, Task 11).
export function fitKeepingTail(prefix: string, text: string, tail: string): string {
  return fit(prefix + tail, text) + tail;
}

const STILL_FAILING = ' (still failing)';

// A problem line is "`command` — error". When it is too long the command is
// shortened from the middle, so the error stays visible (owner decision after
// Task 14); text that isn't in that form is cut at the end. `tail` is an
// ending that follows the result (its width is reserved, it is not added).
const PROBLEM_LINE = /^`(.*?)` — ([\s\S]*)$/;
const MIN_ERROR_CHARS = 40;
const MIN_COMMAND_CHARS = 20;
export function fitProblemLine(prefix: string, text: string, tail = ''): string {
  const m = PROBLEM_LINE.exec(text);
  if (!m) return fit(prefix + tail, text);
  const [command, error] = [m[1] as string, m[2] as string];
  const room = LINE_WIDTH - [...(prefix + tail)].length - 5; // two backticks and " — "
  const [commandLen, errorLen] = [[...command].length, [...error].length];
  if (commandLen + errorLen <= room) return text;
  const shownCommand = clipMiddle(
    command,
    Math.max(room - Math.min(errorLen, MIN_ERROR_CHARS), MIN_COMMAND_CHARS),
  );
  const shownError = clip(error, Math.max(room - [...shownCommand].length, 1));
  return `\`${shownCommand}\` — ${shownError}`;
}

const STATUS_MARK = { ok: '✓', not_found: '–', error: '!' } as const;

type Paint = (text: string) => string;
export function painter(color: boolean) {
  const wrap =
    (code: string): Paint =>
    (t) =>
      color ? `\x1b[${code}m${t}\x1b[0m` : t;
  return {
    bold: wrap('1'),
    red: wrap('31'),
    green: wrap('32'),
    yellow: wrap('33'),
    cyan: wrap('36'),
    dim: wrap('2'),
  };
}

export function header(f: BriefFacts, now: Date): string {
  const where = f.branch ? `${f.project.name} (${f.branch})` : f.project.name;
  const when = f.lastActiveAt
    ? `last active ${relativeAgo(f.lastActiveAt, now)}`
    : 'no activity recorded yet';
  return `Where you left off — ${where} · ${when}`;
}

export function sourcesLine(
  f: BriefFacts,
  separator: string,
  paint?: ReturnType<typeof painter>,
): string {
  const marks = f.sources.map((s) => {
    const mark = STATUS_MARK[s.status];
    const colored = !paint
      ? mark
      : s.status === 'ok'
        ? paint.green(mark)
        : s.status === 'error'
          ? paint.yellow(mark)
          : paint.dim(mark);
    return `${s.name} ${colored}`;
  });
  return `Sources: ${marks.join(separator)}`;
}

export function renderTerminal(
  f: BriefFacts,
  polished: string | null,
  opts: { color: boolean; now?: Date },
): string {
  const now = opts.now ?? new Date();
  const p = painter(opts.color);
  const blocks: string[][] = [[p.bold(fit('', header(f, now)))]];
  if (polished) blocks.push([polished]); // prose, not cut
  const section = (title: string, lines: string[]) => {
    if (lines.length > 0) blocks.push([p.bold(title), ...lines]);
  };
  const bullet = (text: string) => `  • ${fit('  • ', text)}`;
  const problem = (text: string, attempts: string[]) => [
    `  ${p.red('✗')} ${
      text.endsWith(STILL_FAILING)
        ? fitProblemLine('  ✗ ', text.slice(0, -STILL_FAILING.length), STILL_FAILING) +
          STILL_FAILING
        : fitProblemLine('  ✗ ', text)
    }`,
    ...(attempts.length > 0 ? [p.dim(fit('', `    tried: ${attempts.join(' · ')}`))] : []),
  ];
  // At most MAX_ITEMS problems, each with its tried: line, then "+N more".
  const problems = (items: { text: string; attempts: string[] }[]) => [
    ...items.slice(0, MAX_ITEMS).flatMap((x) => problem(x.text, x.attempts)),
    ...(items.length > MAX_ITEMS ? [bullet(`+${items.length - MAX_ITEMS} more`)] : []),
  ];
  const { claimed, open } = splitProblems(f);

  if (f.claimedDone) {
    const c = f.claimedDone;
    section('Agent said done, but', [
      fit('', `  ${c.source} said: "${c.message}" (${relativeAgo(c.at, now)})`),
      ...problems(claimed),
    ]);
  }
  section('Done', capItems(f.done, MAX_ITEMS).map(bullet));
  section(
    'Unfinished',
    capItems(
      f.unfinished.files.map((file) => `${file.path} (${file.status})`),
      MAX_ITEMS,
    ).map(bullet),
  );
  section(
    'Open problems',
    problems(open.map((o) => ({ text: problemText(o), attempts: o.attempts }))),
  );
  section('Notes', f.notes.map(bullet));
  section('Next step', f.nextStep ? [`  ${p.cyan('→')} ${fit('  → ', f.nextStep)}`] : []);
  blocks.push([sourcesLine(f, '  ', opts.color ? p : undefined)]);
  return blocks.map((b) => b.join('\n')).join('\n\n');
}
