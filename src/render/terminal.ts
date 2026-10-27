import type { BriefFacts } from '../brief/facts.ts';
import { relativeAgo } from '../core/time.ts';

// The terminal brief (spec §1.8; the §1.1 example is the exact reference).
// Headings in this order; empty sections omitted; no footer after Sources.

const STATUS_MARK = { ok: '✓', not_found: '–', error: '!' } as const;

type Paint = (text: string) => string;
function painter(color: boolean) {
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
  const blocks: string[][] = [[p.bold(header(f, now))]];
  if (polished) blocks.push([polished]);
  const section = (title: string, lines: string[]) => {
    if (lines.length > 0) blocks.push([p.bold(title), ...lines]);
  };

  if (f.claimedDone) {
    const c = f.claimedDone;
    section('Agent said done, but', [
      `  ${c.source} said: "${c.message}" (${relativeAgo(c.at, now)})`,
      ...c.contradictions.map((x) => `  ${p.red('✗')} ${x}`),
    ]);
  }
  section(
    'Done',
    f.done.map((d) => `  • ${d}`),
  );
  section(
    'Unfinished',
    f.unfinished.files.map((file) => `  • ${file.path} (${file.status}, uncommitted)`),
  );
  section(
    'Open problems',
    f.openProblems.flatMap((o) => [
      `  ${p.red('✗')} ${o.error}`,
      ...(o.attempts.length > 0 ? [p.dim(`    tried: ${o.attempts.join(' · ')}`)] : []),
    ]),
  );
  section(
    'Notes',
    f.notes.map((n) => `  • ${n}`),
  );
  section('Next step', f.nextStep ? [`  ${p.cyan('→')} ${f.nextStep}`] : []);
  blocks.push([sourcesLine(f, '  ', opts.color ? p : undefined)]);
  return blocks.map((b) => b.join('\n')).join('\n\n');
}
