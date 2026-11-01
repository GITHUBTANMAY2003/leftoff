import type { BriefFacts, OpenProblem } from '../brief/facts.ts';
import { attemptWords } from '../brief/failure-words.ts';
import { groupProblems, type ProblemGroup } from '../brief/groups.ts';
import { agentName, plainNextStep } from '../brief/next-step.ts';
import { folderName } from '../brief/work.ts';
import { isLookAround, referencesTempDir } from '../collectors/scratch.ts';
import { commandFiles, displayCommand } from '../model/event.ts';
import { headerLines, youWereLine } from './narrative.ts';
import { LINE_WIDTH, painter } from './terminal.ts';
import { capItems, plural, wrap } from './text.ts';

// `leftoff resume --details` (dogfooding after Task 15c): the brief's plain
// words with every open problem as a numbered block — what is wrong, the key
// error line, the exact command, the files and what was already tried, in
// words. Then what changed and the next step. Raw data stays in --json.

const INDENT = '  ';
const BLOCK = '     ';
const MAX_PROBLEMS = 10;
const MAX_ATTEMPTS = 5;
const MAX_FILES = 5;
const NEXT_NOTE = /^next:\s*/i;

const capital = (text: string) =>
  /^[a-z]/.test(text) ? text[0]?.toUpperCase() + text.slice(1) : text;
const sentence = (text: string) => (/[.!?…]$/.test(text) ? text : `${text}.`);
const joinAnd = (items: string[]) =>
  items.length <= 1 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`;

// An attempt worth listing (dogfooding after Task 15d): one that reads as
// words ("reading a.ts", "checking the diff", "running the core tests"), or a
// real command. Not raw look-arounds (`clear`, `ls … | head`), git chores,
// temp-folder commands or one-off scripts.
function worthListing(attempt: string): boolean {
  if (referencesTempDir(attempt)) return false;
  const words = attemptWords(attempt);
  if (words === 'running a script' || words === 'checking git') return false;
  if (!words.startsWith('`')) return true;
  return !isLookAround(attempt) && !/^git\s/.test(displayCommand(attempt));
}
// An error line that says no more than "it failed".
const SAYS_NOTHING = /^(failed|exit code \d+)$/;

// "Codex said "…". 2 things are still not right:" — a quote that doesn't fit
// the line is left out, never cut.
function introLine(f: BriefFacts, n: number): string {
  if (n === 0) return 'Nothing is failing.';
  const count = n === 1 ? '1 thing is still not right:' : `${n} things are still not right:`;
  const c = f.claimedDone;
  if (!c) return capital(count);
  const whole = !c.message.startsWith('…') && !c.message.endsWith('…');
  const quoted = `${agentName(c.source)} said "${c.message}"${/[.!?]$/.test(c.message) ? '' : '.'} ${count}`;
  return whole && [...(INDENT + quoted)].length <= LINE_WIDTH
    ? quoted
    : `${agentName(c.source)} said it was done. ${count}`;
}

function problemBlock(g: ProblemGroup, i: number): string[] {
  const first = g.problems[0] as OpenProblem;
  const out = wrap(`${INDENT}${i + 1}. `, g.now, LINE_WIDTH).map((l, j) =>
    j === 0 ? l : `${BLOCK}${l.trimStart()}`,
  );
  const line = (text: string) => out.push(...wrap(BLOCK, text, LINE_WIDTH));
  if (!SAYS_NOTHING.test(first.error)) line(`Error output: ${first.error}`);
  const commands = [...new Set(g.problems.flatMap((p) => (p.command === null ? [] : [p.command])))];
  if (commands.length > 0) {
    line(`${commands.length === 1 ? 'Command' : 'Commands'}: ${commands.join('; ')}`);
  }
  const files = [...new Set(commands.flatMap((c) => commandFiles(c)))].sort();
  if (files.length > 0) line(`Files: ${files.join(', ')}`);
  const attempts = g.problems.flatMap((p) => p.attempts).filter(worthListing);
  const tried = [...new Set(attempts.map(attemptWords))].slice(0, MAX_ATTEMPTS);
  line(tried.length > 0 ? `Already tried: ${tried.join(', ')}` : 'Nothing tried yet.');
  return out;
}

function whatChanged(f: BriefFacts): string | null {
  const parts: string[] = [];
  const commits = f.work.commits;
  if (commits.length > 0) {
    parts.push(`${plural(commits.length, 'commit')}, the newest "${commits.at(-1) as string}"`);
  }
  if (f.work.filesChanged > 0) {
    const where = joinAnd(f.work.topFolders.map((t) => folderName(t.path)));
    parts.push(`${plural(f.work.filesChanged, 'file')}${where ? `, most in ${where}` : ''}`);
  }
  return parts.length > 0 ? `What changed: ${parts.join('; ')}` : null;
}

export function renderDetails(
  f: BriefFacts,
  polished: string | null,
  opts: { color: boolean; now?: Date },
): string {
  const p = painter(opts.color);
  // every line wraps; nothing in the full view is cut
  const line = (text: string) => wrap(INDENT, text, LINE_WIDTH).join('\n');
  const [first = '', ...rest] = headerLines(f, opts.now ?? new Date(), LINE_WIDTH);
  const out = [p.bold(first), ...rest];
  if (polished) out.push(...polished.split('\n').map((l) => `${INDENT}${l}`)); // prose, not cut
  const youWere = youWereLine(f.work.workingOn, f.lastIntent);
  if (youWere) out.push(line(youWere));
  const groups = groupProblems(f.openProblems);
  out.push(line(introLine(f, groups.length)));
  groups.slice(0, MAX_PROBLEMS).forEach((g, i) => out.push('', ...problemBlock(g, i)));
  if (groups.length > MAX_PROBLEMS) {
    out.push('', line(`…and ${plural(groups.length - MAX_PROBLEMS, 'more problem')}`));
  }
  out.push('');
  if (f.unfinished.files.length > 0) {
    const files = f.unfinished.files.map((file) => `${file.path} (${file.status})`);
    out.push(line(`Uncommitted: ${capItems(files, MAX_FILES).join(', ')}`));
  }
  const changed = whatChanged(f);
  if (changed) out.push(line(changed));
  const nextNote = [...f.notes].reverse().find((n) => NEXT_NOTE.test(n));
  for (const note of f.notes) if (note !== nextNote) out.push(line(`Note: ${note}`));
  const next = plainNextStep(f);
  if (next) out.push(line(`Next: ${sentence(next)}`));
  return out.join('\n');
}
