import type { BriefFacts } from '../brief/facts.ts';
import { relativeAgo } from '../core/time.ts';
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
  if (f.claimedDone) {
    const c = f.claimedDone;
    section('Agent said done, but', [
      `${c.source} said: "${c.message}" (${relativeAgo(c.at, now)})`,
      '',
      ...c.contradictions.map((x) => `- ✗ ${x}`),
    ]);
  }
  section(
    'Done',
    f.done.map((d) => `- ${d}`),
  );
  section('Unfinished', [
    ...f.unfinished.files.map((file) => `- \`${file.path}\` (${file.status}, uncommitted)`),
    ...(f.unfinished.diffStat && f.unfinished.files.length > 0
      ? [`- ${f.unfinished.diffStat}`]
      : []),
  ]);
  section(
    'Open problems',
    f.openProblems.map(
      (o) =>
        `- **${o.error}**${o.attempts.length > 0 ? ` — tried: ${o.attempts.join(' · ')}` : ''}`,
    ),
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
const LIST_LIMITS = [20, 10, 5, 3, 1, 0];

function capped(items: string[], limit: number): string[] {
  if (items.length <= limit) return items;
  return [...items.slice(0, limit), `- …and ${items.length - limit} more`];
}

function contextBody(f: BriefFacts, polished: string | null, now: Date, limit: number): string[] {
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
    if (items.length > 0) out.push('', title, ...capped(items, limit));
  };
  if (f.claimedDone) {
    list(
      `The agent said "${f.claimedDone.message}", but:`,
      f.claimedDone.contradictions.map((c) => `- ${c}`),
    );
  }
  list(
    'Done:',
    f.done.map((d) => `- ${d}`),
  );
  list(
    'Uncommitted changes:',
    f.unfinished.files.map((file) => `- ${file.path} (${file.status})`),
  );
  list(
    'Open problems (unresolved):',
    f.openProblems.map(
      (o) =>
        `- ${o.error}${o.attempts.length > 0 ? `\n  Already tried (did not fix it): ${o.attempts.join('; ')}` : ''}`,
    ),
  );
  list(
    'Notes from the developer:',
    f.notes.map((n) => `- ${n}`),
  );
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
  for (const limit of LIST_LIMITS) {
    const text = wrap(contextBody(f, polished, now, limit).join('\n'));
    if (text.length <= CONTEXT_MAX) return text;
  }
  const room = CONTEXT_MAX - wrap('').length - 1; // in UTF-16 units, like String.length
  let cut = '';
  for (const ch of contextBody(f, polished, now, 0).join('\n')) {
    if (cut.length + ch.length > room) break;
    cut += ch;
  }
  return wrap(cut + '…');
}
