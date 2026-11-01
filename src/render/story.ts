import type { BriefFacts, OpenProblem } from '../brief/facts.ts';
import { attemptWords } from '../brief/failure-words.ts';
import { groupProblems, type ProblemGroup } from '../brief/groups.ts';
import { agentName, plainNextStep } from '../brief/next-step.ts';
import { builtSentence, type Built, type FileLine } from '../brief/story.ts';
import { folderName } from '../brief/work.ts';
import { isLookAround, referencesTempDir } from '../collectors/scratch.ts';
import { commandFiles, displayCommand, programWords } from '../model/event.ts';
import { headerLines, youWereLine } from './narrative.ts';
import { LINE_WIDTH, painter } from './terminal.ts';
import { plural } from './text.ts';

// `leftoff resume` and `leftoff resume --details` (owner decision after Task
// 15e): exactly three sections — What you did, Files you changed, What's left
// — from the developer's own words (branch, commits, the diff, failures), no
// LLM. --details is the same three sections with, per problem, the exact
// error line, each distinct command once and what was already tried. Raw
// data is in --json only.

export interface Story {
  lines: FileLine[];
  moreFiles: number;
  built: Built;
}

const SECTION = '  ';
const BODY = '    ';
const BULLET = '    • ';
const DETAIL = '      ';
const MAX_FILES: Record<BriefFacts['work']['size'], number> = { small: 4, medium: 6, large: 8 };
const MAX_FILES_DETAILS = 8;
const MAX_ATTEMPTS = 5;
const SAYS_NOTHING = /^(failed|exit code \d+)$/;

const lowerFirst = (text: string) =>
  /^[A-Z][a-z]/.test(text) ? text[0]?.toLowerCase() + text.slice(1) : text;
const sentence = (text: string) => (/[.!?…]$/.test(text) ? text : `${text}.`);

// Wraps at spaces (a `command` stays whole); `rest` indents the next lines.
function wrapWith(first: string, rest: string, text: string): string[] {
  const words = text.match(/[^\s`]*`[^`]*`\S*|\S+/g) ?? [];
  const lines: string[] = [];
  let current = '';
  for (const word of words) {
    const prefix = lines.length === 0 ? first : rest;
    const next = current === '' ? word : `${current} ${word}`;
    if (current !== '' && [...(prefix + next)].length > LINE_WIDTH) {
      lines.push(prefix + current);
      current = word;
    } else current = next;
  }
  if (current !== '') lines.push((lines.length === 0 ? first : rest) + current);
  return lines;
}

// `uv run --no-sync ruff format --check a.py b.py c.py` → "ruff format --check (3 files)"
function shortCommand(command: string): string {
  const shown = displayCommand(command);
  const files = commandFiles(shown);
  if (files.length < 2) return shown; // one file is part of the command (`python send.py`)
  const words = (programWords(shown) ?? shown.split(' ')).filter((w) => !files.includes(w));
  return `${words.join(' ')} (${plural(files.length, 'file')})`;
}

// An attempt worth listing: one that reads as words, or a real command (not a
// raw look-around, git chore, temp-folder command or one-off script).
function worthListing(attempt: string): boolean {
  if (referencesTempDir(attempt)) return false;
  const words = attemptWords(attempt);
  if (words === 'running a script' || words === 'checking git') return false;
  if (!words.startsWith('`')) return true;
  return !isLookAround(attempt) && !/^git\s/.test(displayCommand(attempt));
}

function whatYouDid(f: BriefFacts, story: Story | null): string[] {
  const parts: string[] = [];
  const goal = youWereLine(f.work.workingOn, f.lastIntent);
  if (goal) parts.push(goal);
  const built = story ? builtSentence(story.built) : null;
  if (built) parts.push(built);
  else if (f.work.commits.length > 0) {
    parts.push(
      `You made ${plural(f.work.commits.length, 'commit')}, the newest "${f.work.commits.at(-1) as string}".`,
    );
  } else if (f.work.filesChanged > 0) {
    // at most 3 folders, then "(+N more folders)" (owner decision after Task 15e)
    const folders = f.work.topFolders.map((t) => folderName(t.path));
    const more = f.work.folderCount - folders.length;
    const where =
      folders.length > 0
        ? `, mostly in ${folders.join(', ')}${more > 0 ? ` (+${more} more ${more === 1 ? 'folder' : 'folders'})` : ''}`
        : '';
    parts.push(`You changed ${plural(f.work.filesChanged, 'file')}${where}.`);
  }
  if (f.claimedDone) parts.push(`${agentName(f.claimedDone.source)} said the work was done.`);
  return parts.length > 0 ? wrapWith(BODY, BODY, parts.join(' ')) : [];
}

function filesYouChanged(f: BriefFacts, story: Story | null, details: boolean): string[] {
  if (story === null || story.lines.length === 0) return [];
  const max = details ? MAX_FILES_DETAILS : MAX_FILES[f.work.size];
  const shown = story.lines.slice(0, max);
  const hidden = story.moreFiles + story.lines.slice(max).reduce((n, l) => n + l.files.length, 0);
  return [
    ...shown.flatMap((l) => wrapWith(BULLET, DETAIL, `${l.files.join(', ')} — ${l.text}`)),
    ...(hidden > 0 ? [`${BULLET}+${plural(hidden, 'more file')}`] : []),
  ];
}

function problemDetails(g: ProblemGroup): string[] {
  const first = g.problems[0] as OpenProblem;
  const out: string[] = [];
  if (!SAYS_NOTHING.test(first.error))
    out.push(...wrapWith(DETAIL, `${DETAIL}  `, `Error: ${first.error}`));
  const commands = [
    ...new Set(g.problems.flatMap((p) => (p.command === null ? [] : [shortCommand(p.command)]))),
  ];
  if (commands.length > 0) {
    out.push(
      ...wrapWith(
        DETAIL,
        `${DETAIL}  `,
        `${commands.length === 1 ? 'Command' : 'Commands'}: ${commands.join('; ')}`,
      ),
    );
  }
  const tried = [
    ...new Set(
      g.problems
        .flatMap((p) => p.attempts)
        .filter(worthListing)
        .map(attemptWords),
    ),
  ].slice(0, MAX_ATTEMPTS);
  out.push(
    ...wrapWith(
      DETAIL,
      `${DETAIL}  `,
      tried.length > 0 ? `Already tried: ${tried.join(', ')}` : 'Nothing tried yet.',
    ),
  );
  return out;
}

function whatsLeft(f: BriefFacts, details: boolean): string[] {
  const out: string[] = [];
  for (const g of groupProblems(f.openProblems)) {
    out.push(...wrapWith(BULLET, DETAIL, g.now));
    if (details) out.push(...problemDetails(g));
  }
  const files = f.unfinished.files.length;
  if (files > 0) out.push(`${BULLET}${plural(files, 'uncommitted file')}`);
  if (f.lastAgent?.question) {
    out.push(
      ...wrapWith(
        BULLET,
        DETAIL,
        `${agentName(f.lastAgent.source)} asked: ${f.lastAgent.question}`,
      ),
    );
  }
  // Notes are always shown (P11); the newest "next:" note is where to start.
  const nextNote = [...f.notes].reverse().find((n) => /^next:\s*/i.test(n));
  for (const note of f.notes) {
    if (note !== nextNote) out.push(...wrapWith(BULLET, DETAIL, `Note: ${note}`));
  }
  if (out.length === 0 && f.branch !== null) {
    out.push(`${BULLET}Nothing failing, all changes committed`);
  }
  const start = plainNextStep(f);
  if (start) out.push(...wrapWith(BODY, BODY, `Start here: ${sentence(lowerFirst(start))}`));
  return out;
}

export function renderStory(
  f: BriefFacts,
  story: Story | null,
  opts: { color: boolean; now?: Date; details?: boolean; polished?: string | null },
): string {
  const p = painter(opts.color);
  const [first = '', ...rest] = headerLines(f, opts.now ?? new Date(), LINE_WIDTH);
  const out = [p.bold(first), ...rest];
  // a cached polished summary (optional, off by default) comes first, as prose
  if (opts.polished) out.push(...opts.polished.split('\n').map((l) => `${SECTION}${l}`));
  const section = (title: string, lines: string[]) => {
    if (lines.length > 0) out.push(p.bold(`${SECTION}${title}`), ...lines);
  };
  section('What you did', whatYouDid(f, story));
  section('Files you changed', filesYouChanged(f, story, opts.details === true));
  section("What's left", whatsLeft(f, opts.details === true));
  return out.join('\n');
}
