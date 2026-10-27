import { problemText, type BriefFacts } from '../brief/facts.ts';
import { fit, fitProblemLine, header, painter } from './terminal.ts';

// The automatic brief on terminal open (spec §1.8): the header, then at most
// the uncommitted-file count, the top open problem and the next step, then
// the pointer to `leftoff resume`. Short on purpose: it appears unasked.

const INDENT = '  ';

export function renderAutoBrief(f: BriefFacts, opts: { color: boolean; now?: Date }): string {
  const now = opts.now ?? new Date();
  const p = painter(opts.color);
  const lines = [p.bold(fit('', header(f, now)))];
  const files = f.unfinished.files.length;
  if (files > 0) lines.push(`${INDENT}• ${files} uncommitted file${files === 1 ? '' : 's'}`);
  // One problem fits: the one the next step is about, else the first.
  const verified = /^Verify: `(.*)` still failing$/.exec(f.nextStep ?? '')?.[1];
  const top = f.openProblems.find((p) => p.command === verified) ?? f.openProblems[0];
  if (top) {
    const rest = f.openProblems.length - 1;
    const more = rest > 0 ? ` (+${rest} more problem${rest === 1 ? '' : 's'})` : '';
    lines.push(`${INDENT}✗ ${fitProblemLine(`${INDENT}✗ `, problemText(top), more)}${more}`);
  }
  // A next step that resolves or verifies that problem would only repeat it.
  const repeats =
    top !== undefined &&
    (f.nextStep === `Resolve: ${problemText(top)}` || verified === top.command);
  if (f.nextStep && !repeats) lines.push(`${INDENT}→ ${fit(`${INDENT}→ `, f.nextStep)}`);
  lines.push('Run `leftoff resume` for details');
  return lines.join('\n');
}
