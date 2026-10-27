import { problemText, type BriefFacts } from '../brief/facts.ts';
import { relativeAgo } from '../core/time.ts';
import { splitProblems } from './problems.ts';

// The terminal brief (spec §1.8; the §1.1 example is the exact reference).
// Headings in this order; empty sections omitted; no footer after Sources.

// Each fact line is cut to this many characters (code points) with "…"; only
// the terminal does this (owner decision after Task 10).
export const LINE_WIDTH = 100;

export function fit(prefix: string, text: string, width = LINE_WIDTH): string {
  const room = width - [...prefix].length;
  const chars = [...text];
  return chars.length <= room ? text : chars.slice(0, Math.max(0, room - 1)).join('') + '…';
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
    `  ${p.red('✗')} ${fit('  ✗ ', text)}`,
    ...(attempts.length > 0 ? [p.dim(fit('', `    tried: ${attempts.join(' · ')}`))] : []),
  ];
  const { claimed, open } = splitProblems(f);

  if (f.claimedDone) {
    const c = f.claimedDone;
    section('Agent said done, but', [
      fit('', `  ${c.source} said: "${c.message}" (${relativeAgo(c.at, now)})`),
      ...claimed.flatMap((x) => problem(x.text, x.attempts)),
    ]);
  }
  section('Done', f.done.map(bullet));
  section(
    'Unfinished',
    f.unfinished.files.map((file) => bullet(`${file.path} (${file.status})`)),
  );
  section(
    'Open problems',
    open.flatMap((o) => problem(problemText(o), o.attempts)),
  );
  section('Notes', f.notes.map(bullet));
  section('Next step', f.nextStep ? [`  ${p.cyan('→')} ${fit('  → ', f.nextStep)}`] : []);
  blocks.push([sourcesLine(f, '  ', opts.color ? p : undefined)]);
  return blocks.map((b) => b.join('\n')).join('\n\n');
}
