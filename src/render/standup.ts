import { editedPaths, problemText, shortList, type BriefFacts } from '../brief/facts.ts';
import type { Source, WorkEvent } from '../model/event.ts';

// `leftoff standup` (spec §1.8): Yesterday, Today, Blockers. Plain text meant
// to be pasted into a chat, so lines are not cut to the terminal width.

export interface Standup {
  yesterday: string[];
  today: string[];
  blockers: string[];
}

const NO_ACTIVITY = 'No activity recorded in this period';
const toolName = (s: Source) => (s === 'shell' ? 'the shell' : s);
const joinAnd = (items: string[]) =>
  items.length <= 1 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`;
const unique = <T>(items: T[]) => [...new Set(items)];

// Yesterday for one project: its commit subjects; without commits, what was
// edited and by which agent (plan review B4); without edits, the last request
// to an agent; otherwise where the work happened (owner decision, Task 11).
function workedOn(f: BriefFacts, events: WorkEvent[]): string[] {
  const commits = events.filter((e) => e.kind === 'commit').map((e) => e.summary);
  if (commits.length > 0) return commits;
  const edits = events.filter((e) => e.kind === 'file_edit');
  if (edits.length > 0) {
    const agents = unique(edits.map((e) => toolName(e.source)));
    return [`Worked on ${shortList(editedPaths(edits, f.project.root))} with ${joinAnd(agents)}`];
  }
  const request = [...events].reverse().find((e) => e.kind === 'user_prompt');
  if (request) return [`Worked on: ${request.summary}`];
  if (events.length === 0) return [];
  const tools = unique(
    events.filter((e) => e.source !== 'git' && e.source !== 'user').map((e) => toolName(e.source)),
  );
  return [`Worked in ${f.project.name}${tools.length > 0 ? ` with ${joinAnd(tools)}` : ''}`];
}

export function buildStandup(
  input: { factsByProject: BriefFacts[]; eventsSince: WorkEvent[] },
  opts: { prefix: boolean } = { prefix: false },
): Standup {
  const s: Standup = { yesterday: [], today: [], blockers: [] };
  for (const f of input.factsByProject) {
    const tag = (item: string) => (opts.prefix ? `${f.project.name}: ${item}` : item);
    const events = input.eventsSince.filter((e) => e.projectRoot === f.project.root);
    s.yesterday.push(...workedOn(f, events).map(tag));
    if (f.nextStep) s.today.push(tag(f.nextStep));
    s.blockers.push(...f.openProblems.map((p) => tag(problemText(p))));
  }
  if (s.yesterday.length === 0) s.yesterday.push(NO_ACTIVITY);
  return s;
}

export function renderStandup(s: Standup): string {
  const section = (title: string, items: string[]) =>
    items.length > 0 ? [`${title}:`, ...items.map((i) => `- ${i}`)] : [`${title}: none`];
  return [
    ...section('Yesterday', s.yesterday),
    ...section('Today', s.today),
    ...section('Blockers', s.blockers),
  ].join('\n');
}
