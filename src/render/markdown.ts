import { problemText, type BriefFacts } from '../brief/facts.ts';
import { relativeAgo } from '../core/time.ts';
import { splitProblems } from './problems.ts';
import { capItems, clip } from './text.ts';
import { sourcesLine } from './terminal.ts';

// `leftoff resume --md`, and the context handed to new Claude Code sessions.

export function renderMarkdown(
  f: BriefFacts,
  polished: string | null,
  opts: { now?: Date } = {},
): string {
  const now = opts.now ?? new Date();
  const where = f.branch ? `${f.project.name} (${f.branch})` : f.project.name;
  const blocks: string[] = [
    `## Where you left off — ${where}`,
    f.lastActiveAt
      ? `_Last active ${relativeAgo(f.lastActiveAt, now)}_`
      : '_No activity recorded yet_',
  ];
  if (polished) blocks.push(polished);
  const section = (title: string, body: string[]) => {
    if (body.length > 0) blocks.push(`### ${title}\n\n${body.join('\n')}`);
  };
  const tried = (attempts: string[]) =>
    attempts.length > 0 ? ` — tried: ${attempts.join(' · ')}` : '';
  const { claimed, open } = splitProblems(f);
  if (f.claimedDone) {
    const c = f.claimedDone;
    section('Agent said done, but', [
      `${c.source} said: "${c.message}" (${relativeAgo(c.at, now)})`,
      '',
      ...claimed.map((x) => `- ✗ ${x.text}${tried(x.attempts)}`),
    ]);
  }
  section(
    'Done',
    f.done.map((d) => `- ${d}`),
  );
  section('Unfinished', [
    ...f.unfinished.files.map((file) => `- \`${file.path}\` (${file.status})`),
    ...(f.unfinished.diffStat && f.unfinished.files.length > 0
      ? [`- ${f.unfinished.diffStat}`]
      : []),
  ]);
  section(
    'Open problems',
    open.map((o) => `- **${problemText(o)}**${tried(o.attempts)}`),
  );
  section(
    'Notes',
    f.notes.map((n) => `- ${n}`),
  );
  section('Next step', f.nextStep ? [`→ ${f.nextStep}`] : []);
  blocks.push(sourcesLine(f, ' · '));
  return blocks.join('\n\n');
}

const CONTEXT_FIRST = '## Previous session in this project (from leftoff)';
const CONTEXT_LAST =
  'This is an automatic summary of earlier work. Verify against the code before relying on it.';
const CONTEXT_MAX = 4000;
// Items per list and characters per item, tried in turn until the context
// fits. Lists are never emptied: items are shortened instead (owner decision
// after Task 13).
const LIST_SHAPES: { items: number; chars: number }[] = [
  { items: 5, chars: 300 },
  { items: 5, chars: 160 },
  { items: 3, chars: 120 },
  { items: 3, chars: 80 },
];

function contextBody(
  f: BriefFacts,
  polished: string | null,
  now: Date,
  shape: { items: number; chars: number },
): string[] {
  const cut = (text: string) => clip(text, shape.chars);
  const where = [
    f.project.name,
    f.branch ? `branch ${f.branch}` : null,
    f.lastActiveAt ? `last active ${relativeAgo(f.lastActiveAt, now)}` : null,
  ]
    .filter(Boolean)
    .join(' · ');
  const out: string[] = [`Project: ${where}`];
  if (polished) out.push('', polished);
  if (f.lastIntent) out.push('', `Last request: ${f.lastIntent}`);
  const list = (title: string, items: string[]) => {
    if (items.length > 0)
      out.push('', title, ...capItems(items, shape.items).map((item) => `- ${item}`));
  };
  if (f.claimedDone) {
    list(`The agent said "${f.claimedDone.message}", but:`, f.claimedDone.contradictions.map(cut));
  }
  list('Done:', f.done.map(cut));
  list(
    'Uncommitted changes:',
    f.unfinished.files.map((file) => cut(`${file.path} (${file.status})`)),
  );
  list(
    'Open problems (unresolved):',
    f.openProblems.map(
      (o) =>
        `${cut(problemText(o))}${o.attempts.length > 0 ? `\n  Already tried (did not fix it): ${cut(o.attempts.join('; '))}` : ''}`,
    ),
  );
  list('Notes from the developer:', f.notes.map(cut));
  if (f.nextStep) out.push('', `Suggested next step: ${f.nextStep}`);
  return out;
}

// Markdown for Claude Code's additionalContext (§1.8): exact first and last
// lines, at most 4000 characters. Lists are shortened first; prose (the
// polished paragraph, the last request) is only cut as a last resort.
export function renderAgentContext(
  f: BriefFacts,
  polished: string | null,
  opts: { now?: Date } = {},
): string {
  const now = opts.now ?? new Date();
  const wrap = (body: string) => `${CONTEXT_FIRST}\n\n${body}\n\n${CONTEXT_LAST}`;
  for (const shape of LIST_SHAPES) {
    const text = wrap(contextBody(f, polished, now, shape).join('\n'));
    if (text.length <= CONTEXT_MAX) return text;
  }
  const room = CONTEXT_MAX - wrap('').length - 1; // in UTF-16 units, like String.length
  let cut = '';
  for (const ch of contextBody(
    f,
    polished,
    now,
    LIST_SHAPES.at(-1) as (typeof LIST_SHAPES)[0],
  ).join('\n')) {
    if (cut.length + ch.length > room) break;
    cut += ch;
  }
  return wrap(cut + '…');
}
