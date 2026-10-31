import { contradictionOf, shortList, type BriefFacts, type OpenProblem } from '../brief/facts.ts';
import { describeFailure } from '../brief/failure-words.ts';
import { agentName } from '../brief/next-step.ts';
import { relativeAgo } from '../core/time.ts';
import { fit, fitProblemLine, LINE_WIDTH, painter } from './terminal.ts';
import { clip, plural } from './text.ts';

// The narrative brief (Task 15b): what you asked, what the agent last said,
// what got done, where it stopped and how to pick up, in plain words. Fixed
// templates over the facts, no AI. Used by the auto brief, `leftoff resume`
// and the agent context; `leftoff resume --details` keeps the full lists.

const INDENT = '  ';
const SHOWN_DONE = 2;
const NEXT_NOTE = /^next:\s*/i;
const UNCOMMITTED = /^(\d+) uncommitted files?$/;

const words = (p: OpenProblem) => describeFailure(p.command, p.error);

// Sentences of one-line text: split after . ! ? before the next word.
const sentences = (text: string) =>
  text
    .replace(/\s+/g, ' ')
    .trim()
    .split(/(?<=[.!?])\s+(?=\S)/);

// "You asked": the first sentence of the request, about 100 characters at
// most, after any leading @file mentions (owner decision after Task 15b).
const MAX_ASKED_CHARS = 100;
function askedLine(request: string): string {
  const text = request.replace(/^(@\S+\s+)+/, '');
  return clip(sentences(text)[0] ?? text, MAX_ASKED_CHARS);
}

// The auto brief's polished summary: at most two sentences, about 200
// characters (owner decision after Task 15b); `resume` shows it whole.
const MAX_SHORT_POLISH_CHARS = 200;
export function shortPolish(text: string): string {
  const [first = '', second] = sentences(text);
  const both = second === undefined ? first : `${first} ${second}`;
  return clip([...both].length <= MAX_SHORT_POLISH_CHARS ? both : first, MAX_SHORT_POLISH_CHARS);
}
const isCommit = (item: string) => !/^Edited \d+ files?: /.test(item);

// The problem the claim sentence names, when its first contradiction is one.
function claimedProblem(f: BriefFacts): OpenProblem | null {
  const first = f.claimedDone?.contradictions[0];
  return f.openProblems.find((p) => contradictionOf(p) === first) ?? null;
}

// `Claude said "All tests pass", but the billing tests are still failing.`
function claimSentence(f: BriefFacts): string | null {
  const c = f.claimedDone;
  if (!c) return null;
  const said = `${agentName(c.source)} said "${c.message}", but`;
  const problem = claimedProblem(f);
  if (problem) return `${said} ${words(problem).still}.`;
  const n = Number(UNCOMMITTED.exec(c.contradictions[0] ?? '')?.[1] ?? 0);
  if (n > 0) return `${said} ${plural(n, 'file')} ${n === 1 ? 'is' : 'are'} still uncommitted.`;
  return `${said} ${c.contradictions[0] ?? 'something is still open'}.`;
}

// A long claim is shortened inside its quote, so `", but …` stays visible.
function fitClaim(sentence: string, indent: string, width: number): string {
  const m = /^(.*? said ")(.*)(", but .*)$/.exec(sentence);
  if (!m) return fit(indent, sentence, width);
  const [head, quoteText, tail] = [m[1] as string, m[2] as string, m[3] as string];
  const room = width - [...(indent + head + tail)].length;
  return room < 20 ? fit(indent, sentence, width) : `${head}${clip(quoteText, room)}${tail}`;
}

// "Pick up with": the same order as the facts' next step (§1.7), in plain words.
export function plainNextStep(f: BriefFacts): string | null {
  const note = [...f.notes].reverse().find((n) => NEXT_NOTE.test(n));
  if (note !== undefined) return note.replace(NEXT_NOTE, '');
  if (f.lastAgent?.question) {
    return `Answer ${agentName(f.lastAgent.source)}'s question: ${f.lastAgent.question}`;
  }
  if (f.claimedDone) {
    const problem = claimedProblem(f);
    if (problem) return words(problem).fix;
    const n = Number(UNCOMMITTED.exec(f.claimedDone.contradictions[0] ?? '')?.[1] ?? 0);
    if (n > 0) {
      const agent = agentName(f.claimedDone.source);
      return `Commit the ${plural(n, 'file')} ${agent} said ${n === 1 ? 'was' : 'were'} committed`;
    }
  }
  const top = f.openProblems[0];
  if (top) return words(top).fix;
  const files = f.unfinished.files.map((file) => file.path);
  if (files.length > 0) {
    return `Review and commit ${plural(files.length, 'uncommitted file')} (${shortList(files)})`;
  }
  if (f.done.some(isCommit)) {
    return 'Start the next task (everything from the last session is committed)';
  }
  return f.lastIntent !== null ? `Continue: ${f.lastIntent}` : null;
}

function stillOpen(f: BriefFacts, shownProblem: boolean): string {
  const more = f.openProblems.length - (shownProblem ? 1 : 0);
  const files = f.unfinished.files.length;
  const parts: string[] = [];
  if (more > 0) parts.push(`${more} more ${more === 1 ? 'problem' : 'problems'}`);
  if (files > 0) parts.push(plural(files, 'uncommitted file'));
  // Without a branch there is no git status to speak for.
  else if (f.branch !== null)
    parts.push(parts.length > 0 ? 'all changes committed' : 'nothing, all changes committed');
  return `Still open: ${parts.length > 0 ? parts.join(' · ') : 'nothing'}`;
}

// Commits newest first, then the edited files.
function doneLine(facts: string[]): string | null {
  const done = [...facts.filter(isCommit).reverse(), ...facts.filter((d) => !isCommit(d))];
  if (done.length === 0) return null;
  const rest = done.length - SHOWN_DONE;
  return `Done: ${done.slice(0, SHOWN_DONE).join(' · ')}${rest > 0 ? ` (+${rest} more)` : ''}`;
}

// The lines of the narrative. `width: null` (agent context): no indent, each
// fact line cut to `maxChars` when given. A number (terminal): lines after the
// first are indented and cut to that width; a problem keeps its error visible.
// The polished paragraph is prose and is never cut.
export function narrativeLines(
  f: BriefFacts,
  polished: string | null,
  opts: { now: Date; width: number | null; maxChars?: number },
): string[] {
  const indent = opts.width === null ? '' : INDENT;
  const line = (text: string) =>
    opts.width === null
      ? opts.maxChars === undefined
        ? text
        : clip(text, opts.maxChars)
      : `${indent}${fit(indent, text, opts.width)}`;
  const first = [
    f.project.name,
    f.lastActiveAt ? relativeAgo(f.window.to, opts.now) : 'no activity recorded yet',
    ...(f.branch ? [`branch ${f.branch}`] : []),
  ].join(' · ');
  const out = [opts.width === null ? first : fit('', first, opts.width)];
  if (polished) out.push(...polished.split('\n').map((l) => `${indent}${l}`)); // prose, not cut
  if (f.lastIntent) out.push(line(`You asked: ${askedLine(f.lastIntent)}`));
  if (f.lastAgent) {
    out.push(line(`${agentName(f.lastAgent.source)}'s last update: ${f.lastAgent.update}`));
  }
  const done = doneLine(f.done);
  if (done) out.push(line(done));
  const claim = claimSentence(f);
  if (claim)
    out.push(opts.width === null ? line(claim) : `${indent}${fitClaim(claim, indent, opts.width)}`);
  const top = claim !== null && claimedProblem(f) !== null ? null : (f.openProblems[0] ?? null);
  if (top) {
    const label = 'It stopped with: ';
    const text = words(top).now;
    out.push(
      opts.width === null
        ? line(`${label}${text}`)
        : `${indent}${label}${fitProblemLine(indent + label, text)}`,
    );
  }
  out.push(line(stillOpen(f, top !== null || claimedProblem(f) !== null)));
  // Notes are always shown (P11); the newest "next:" note is the next step.
  const nextNote = [...f.notes].reverse().find((n) => NEXT_NOTE.test(n));
  for (const note of f.notes) if (note !== nextNote) out.push(line(`Note: ${note}`));
  const next = plainNextStep(f);
  if (next) out.push(line(`Pick up with: ${next}`));
  return out;
}

const DETAILS = 'Exact commands, errors and attempts: `leftoff resume --details`';

// `leftoff resume`: the narrative, then where the details are.
export function renderBrief(
  f: BriefFacts,
  polished: string | null,
  opts: { color: boolean; now?: Date },
): string {
  const p = painter(opts.color);
  const [first = '', ...rest] = narrativeLines(f, polished, {
    now: opts.now ?? new Date(),
    width: LINE_WIDTH,
  });
  return [p.bold(first), ...rest, '', DETAILS].join('\n');
}
