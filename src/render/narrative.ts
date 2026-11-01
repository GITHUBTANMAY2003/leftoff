import type { BriefFacts } from '../brief/facts.ts';
import { groupProblems, type ProblemGroup } from '../brief/groups.ts';
import { agentName, claimedProblem, plainNextStep } from '../brief/next-step.ts';
import { folderName, substantiveSentence } from '../brief/work.ts';
import { relativeAgo } from '../core/time.ts';
import { fit, fitKeepingTail, fitProblemLine, LINE_WIDTH, painter } from './terminal.ts';
import { clip, plural, wrap } from './text.ts';

// The brief in plain words, as long as the work was big (owner requests after
// Task 15b and Task 17): small work 2–3 lines, medium ~5–6, large ~8–12 in
// sections. Fixed templates over the facts, no AI. Used by `leftoff resume`
// and the agent context; the auto brief and loose ends use the compact lines
// (compactLines). `leftoff resume --details` keeps the full lists.

const INDENT = '  ';
const BULLET = '    • ';
const NEXT_NOTE = /^next:\s*/i;
const UNCOMMITTED = /^(\d+) uncommitted files?$/;
const SHOWN_COMMITS_MEDIUM = 2;
const SHOWN_COMMITS_LARGE = 3;
const SHOWN_PROBLEM_GROUPS = 2;

// Sentences of one-line text: split after . ! ? before the next word.
const sentences = (text: string) =>
  text
    .replace(/\s+/g, ' ')
    .trim()
    .split(/(?<=[.!?])\s+(?=\S)/);

// The auto brief's polished summary: at most two sentences, about 200
// characters (owner decision after Task 15b); `resume` shows it whole.
const MAX_SHORT_POLISH_CHARS = 200;
export function shortPolish(text: string): string {
  const [first = '', second] = sentences(text);
  const both = second === undefined ? first : `${first} ${second}`;
  return clip([...both].length <= MAX_SHORT_POLISH_CHARS ? both : first, MAX_SHORT_POLISH_CHARS);
}

// A line that ends a sentence: "." unless it already ends in . ! ? or ….
const sentence = (text: string) => (/[.!?…]$/.test(text) ? text : `${text}.`);
const joinAnd = (items: string[]) =>
  items.length <= 1 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`;

// ---- the pieces ----

// "about 15 min", "about 1.5 hours over 2 days"
function workTime(f: BriefFacts): string | null {
  const { activeMinutes: m, days } = f.work;
  if (m <= 0) return null;
  let time: string;
  if (m < 50) time = `about ${Math.max(5, Math.round(m / 5) * 5)} min`;
  else if (m < 600) {
    const hours = Math.round(m / 30) / 2;
    time = `about ${hours} ${hours === 1 ? 'hour' : 'hours'}`;
  } else time = `about ${Math.round(m / 30) / 2} hours`;
  return days > 1 ? `${time} over ${days} days` : time;
}

export function headerLine(f: BriefFacts, now: Date): string {
  return headerParts(f, now, true, true).join(' · ');
}

function headerParts(f: BriefFacts, now: Date, withTime: boolean, withBranch: boolean): string[] {
  const time = withTime ? workTime(f) : null;
  return [
    f.project.name,
    f.lastActiveAt ? `last worked ${relativeAgo(f.window.to, now)}` : 'no activity recorded yet',
    ...(time ? [time] : []),
    ...(withBranch && f.branch ? [`branch ${f.branch}`] : []),
  ];
}

// The header, never cut (owner decision after Task 15d): too long for one
// line, it first drops the time estimate, then puts the branch on its own line.
export function headerLines(f: BriefFacts, now: Date, width: number | null): string[] {
  const full = headerLine(f, now);
  if (width === null || [...full].length <= width) return [full];
  const noTime = headerParts(f, now, false, true).join(' · ');
  if ([...noTime].length <= width) return [noTime];
  return [headerParts(f, now, true, false).join(' · '), `${INDENT}on branch ${f.branch as string}`];
}

// "You were building forgot password." — from the work summary, else the
// first sentence of the last request.
export function youWereLine(workingOn: string | null, lastIntent: string | null): string | null {
  if (workingOn) return sentence(`You were ${workingOn}`);
  // The same filter as the work summary: no hedges, statements or questions.
  const request = lastIntent === null ? null : substantiveSentence(lastIntent);
  return request === null ? null : sentence(`You were working on: ${request}`);
}
const workingOnLine = (f: BriefFacts) => youWereLine(f.work.workingOn, f.lastIntent);

// `Claude said "All tests pass", but the billing tests are still failing.`
function claimSentence(f: BriefFacts): string | null {
  const c = f.claimedDone;
  if (!c) return null;
  // A quote is a complete sentence or nothing (dogfooding after Task 15c).
  const whole = !c.message.startsWith('…') && !c.message.endsWith('…');
  const said = whole
    ? `${agentName(c.source)} said "${c.message}", but`
    : `${agentName(c.source)} said it was done, but`;
  const group = claimGroup(f);
  if (group) return `${said} ${group.still}.`;
  const n = Number(UNCOMMITTED.exec(c.contradictions[0] ?? '')?.[1] ?? 0);
  if (n > 0) return `${said} ${plural(n, 'file')} ${n === 1 ? 'is' : 'are'} still uncommitted.`;
  return `${said} ${c.contradictions[0] ?? 'something is still open'}.`;
}

// A claim that doesn't fit drops its quote ("Claude said it was done, but
// …"): a quote is never cut, and the "but" part always stays.
// Still too long without the quote, the line wraps (never cut, after 15d).
function fitClaim(text: string, prefix: string, width: number): string[] {
  if ([...(prefix + text)].length <= width) return [`${prefix}${text}`];
  const m = /^(.*? said ")(.*)(", but .*)$/.exec(text);
  const unquoted = m
    ? `${(m[1] as string).replace(/ said "$/, ' said it was done')}${(m[3] as string).slice(1)}`
    : text;
  return wrap(prefix, unquoted, width);
}

// The agent's last update as whole sentences that fit in `room` characters; a
// sentence cut when it was stored (ending in "…") is never shown. Null when
// not even the first sentence fits.
function wholeSentences(text: string, room: number): string | null {
  let out = '';
  for (const s of sentences(text)) {
    if (s.endsWith('…')) break;
    const next = out === '' ? s : `${out} ${s}`;
    if ([...next].length > room) break;
    out = next;
  }
  return out === '' ? null : out;
}

// The shared problem groups (one count in every view, after Task 15d): the
// group the claim names, and the others, newest first.
function claimGroup(f: BriefFacts): ProblemGroup | null {
  const named = claimedProblem(f);
  return named === null
    ? null
    : (groupProblems(f.openProblems).find((g) => g.problems.includes(named)) ?? null);
}
function otherGroups(f: BriefFacts): ProblemGroup[] {
  const named = claimedProblem(f);
  return groupProblems(f.openProblems).filter((g) => named === null || !g.problems.includes(named));
}

// The claim says the files are uncommitted ("Committed", 3 uncommitted files).
const claimNamesFiles = (f: BriefFacts) =>
  claimedProblem(f) === null && UNCOMMITTED.test(f.claimedDone?.contradictions[0] ?? '');

const commitsText = (f: BriefFacts, shown: number) => {
  const newest = [...f.work.commits].reverse();
  return `${plural(newest.length, 'commit')}: ${newest.slice(0, shown).join('; ')}`;
};
const foldersText = (f: BriefFacts) => joinAnd(f.work.topFolders.map((t) => folderName(t.path)));

// ---- writing lines ----

type Opts = { now: Date; width: number | null; maxChars?: number };

interface Writer {
  out: string[];
  indent: string;
  bullet: string;
  line(text: string, prefix?: string): void;
  wrapLine(text: string): void; // wraps instead of cutting
  room(prefix?: string): number; // characters left on a line after `prefix`
  tailLine(text: string, tail: string, prefix?: string): void; // keeps `tail` whole
  problemLine(label: string, text: string, tail: string, prefix?: string): void;
  claimLine(text: string, prefix?: string): void;
}

function writer(opts: Opts): Writer {
  const terminal = opts.width !== null;
  const indent = terminal ? INDENT : '';
  const out: string[] = [];
  const cut = (prefix: string, text: string) =>
    terminal
      ? `${prefix}${fit(prefix, text, opts.width as number)}`
      : `${prefix}${opts.maxChars === undefined ? text : clip(text, opts.maxChars)}`;
  return {
    out,
    indent,
    bullet: terminal ? BULLET : '- ',
    line: (text, prefix = indent) => out.push(cut(prefix, text)),
    wrapLine: (text) =>
      out.push(...(terminal ? wrap(indent, text, opts.width as number) : [cut(indent, text)])),
    room: (prefix = indent) =>
      terminal
        ? (opts.width as number) - [...prefix].length
        : (opts.maxChars ?? Number.MAX_SAFE_INTEGER),
    tailLine: (text, tail, prefix = indent) =>
      out.push(
        terminal ? `${prefix}${fitKeepingTail(prefix, text, tail)}` : cut(prefix, `${text}${tail}`),
      ),
    problemLine: (label, text, tail, prefix = indent) =>
      out.push(
        terminal
          ? `${prefix}${label}${fitProblemLine(prefix + label, text, tail)}${tail}`
          : cut(prefix, `${label}${text}${tail}`),
      ),
    claimLine: (text, prefix = indent) =>
      out.push(...(terminal ? fitClaim(text, prefix, opts.width as number) : [cut(prefix, text)])),
  };
}

const extras = (f: BriefFacts, more: number) => [
  ...(more > 0 ? [`${more} more ${more === 1 ? 'problem' : 'problems'}`] : []),
  ...(f.unfinished.files.length > 0 && !claimNamesFiles(f)
    ? [plural(f.unfinished.files.length, 'uncommitted file')]
    : []),
];

// One or two lines: the claim (with what else is open), or the top problem
// (with the rest counted), or the uncommitted files, or "nothing open".
function stoppedLines(f: BriefFacts, w: Writer): void {
  const claim = claimSentence(f);
  if (claim) {
    w.claimLine(claim);
    const also = extras(f, otherGroups(f).length);
    if (also.length > 0) w.line(`Also open: ${also.join(' · ')}`);
    return;
  }
  const groups = otherGroups(f);
  const top = groups[0];
  const files = f.unfinished.files.length;
  if (top !== undefined) {
    const rest = extras(f, groups.length - 1);
    w.problemLine('Stopped: ', top.now, rest.length > 0 ? ` · ${rest.join(' · ')}` : '');
  } else if (files > 0) w.line(`Stopped: ${plural(files, 'uncommitted file')}`);
  else if (f.branch !== null) w.line('Stopped: nothing open, all changes committed');
}

function notesAndNext(f: BriefFacts, w: Writer): void {
  const nextNote = [...f.notes].reverse().find((n) => NEXT_NOTE.test(n));
  for (const note of f.notes) if (note !== nextNote) w.line(`Note: ${note}`);
  const next = plainNextStep(f);
  if (next) w.wrapLine(`Next: ${sentence(next)}`); // the next step is never cut
}

// Large work: the newest commit subjects, one per line under the count
// (owner decision after Task 15c); a single commit stays on its line.
function commitLines(f: BriefFacts, w: Writer): void {
  const newest = [...f.work.commits].reverse();
  if (newest.length === 1) {
    w.line(`1 commit: ${newest[0] as string}`, w.bullet);
    return;
  }
  w.line(`${plural(newest.length, 'commit')}, the newest:`, w.bullet);
  const sub = w.bullet === '- ' ? '  - ' : '        ';
  for (const subject of newest.slice(0, SHOWN_COMMITS_LARGE)) w.line(subject, sub);
}

function updateText(f: BriefFacts, w: Writer, prefix?: string): string | null {
  if (!f.lastAgent) return null;
  const label = `${agentName(f.lastAgent.source)}'s last update: `;
  const text = wholeSentences(f.lastAgent.update, w.room(prefix) - [...label].length);
  return text === null ? null : `${label}${text}`;
}
function updateLine(f: BriefFacts, w: Writer, prefix?: string): void {
  const text = updateText(f, w, prefix);
  if (text !== null) w.line(text, prefix);
}

// Small work: what it was about (and a claim, when there is one), then next.
function smallLines(f: BriefFacts, w: Writer): void {
  const working = workingOnLine(f);
  if (working) w.line(working);
  const claim = claimSentence(f);
  if (claim) w.claimLine(claim);
}

// Medium work: what it was about, done, the agent's last word, where it stopped.
function mediumLines(f: BriefFacts, w: Writer): void {
  const working = workingOnLine(f);
  if (working) w.line(working);
  if (f.work.commits.length > 0) w.line(`Done: ${commitsText(f, SHOWN_COMMITS_MEDIUM)}`);
  else if (f.work.filesChanged > 0) {
    w.line(`Done: changed ${plural(f.work.filesChanged, 'file')}, most in ${foldersText(f)}`);
  }
  if (f.lastAgent && !f.claimedDone) updateLine(f, w);
  stoppedLines(f, w);
}

// Large work: sections, each only when it has something to say.
function largeLines(f: BriefFacts, w: Writer): void {
  const working = workingOnLine(f);
  if (working) w.line(working);

  const done: (() => void)[] = [];
  if (f.work.commits.length > 0) {
    done.push(() => commitLines(f, w));
  }
  if (f.work.filesChanged > 0) {
    const n = plural(f.work.filesChanged, 'file');
    done.push(() =>
      f.work.commits.length > 0
        ? w.tailLine(`Most changes in ${foldersText(f)}`, ` (${n})`, w.bullet)
        : w.line(`Changed ${n}, most in ${foldersText(f)}`, w.bullet),
    );
  }
  if (done.length > 0) {
    w.line('What got done');
    for (const write of done) write();
  }

  const stopped: (() => void)[] = [];
  const claim = claimSentence(f);
  if (claim) stopped.push(() => w.claimLine(claim, w.bullet));
  else if (f.lastAgent && updateText(f, w, w.bullet) !== null) {
    stopped.push(() => updateLine(f, w, w.bullet));
  }
  const groups = otherGroups(f);
  const shown = groups.slice(0, SHOWN_PROBLEM_GROUPS).map((g) => g.now);
  const others = groups.length - shown.length;
  shown.forEach((text, i) => {
    const tail =
      i === shown.length - 1 && others > 0
        ? ` (and ${others} more ${others === 1 ? 'problem' : 'problems'})`
        : '';
    stopped.push(() => w.problemLine('', text, tail, w.bullet));
  });
  const files = f.unfinished.files.length;
  if (files > 0 && !claimNamesFiles(f)) {
    stopped.push(() => w.line(plural(files, 'uncommitted file'), w.bullet));
  } else if (!claim && groups.length === 0 && f.branch !== null) {
    stopped.push(() => w.line('Nothing failing, all changes committed', w.bullet));
  }
  w.line('Where it stopped');
  for (const write of stopped) write();
}

function header(f: BriefFacts, polished: string | null, opts: Opts, w: Writer): void {
  w.out.push(...headerLines(f, opts.now, opts.width));
  if (polished) w.out.push(...polished.split('\n').map((l) => `${w.indent}${l}`)); // prose, not cut
}

// The brief, sized by the work. `width: null` (agent context): no indent,
// bullets as "- ", each line cut to `maxChars` when given. A number
// (terminal): lines after the first are indented and cut to that width; a
// problem keeps its error visible.
export function narrativeLines(f: BriefFacts, polished: string | null, opts: Opts): string[] {
  const w = writer(opts);
  header(f, polished, opts, w);
  if (f.work.size === 'small') smallLines(f, w);
  else if (f.work.size === 'medium') mediumLines(f, w);
  else largeLines(f, w);
  notesAndNext(f, w);
  return w.out;
}

// The compact form (auto brief, loose ends): what it was about, where it
// stopped, next.
export function compactLines(f: BriefFacts, polished: string | null, opts: Opts): string[] {
  const w = writer(opts);
  header(f, polished, opts, w);
  const working = workingOnLine(f);
  if (working) w.line(working);
  stoppedLines(f, w);
  notesAndNext(f, w);
  return w.out;
}

const DETAILS = 'Exact commands, errors and attempts: `leftoff resume --details`';

// `leftoff resume`: the sized brief, then where the details are.
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
