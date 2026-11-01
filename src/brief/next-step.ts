import type { Source } from '../model/event.ts';
import {
  contradictionOf,
  problemText,
  shortList,
  type BriefFacts,
  type OpenProblem,
} from './facts.ts';
import { groupProblems } from './groups.ts';

// The next step covers at most this many problem groups (owner decision after 15d).
const MAX_NEXT_GROUPS = 3;

export const agentName = (source: Source): string =>
  ({ claude: 'Claude', codex: 'Codex' })[source as 'claude' | 'codex'] ?? 'The agent';

const NEXT_NOTE = /^next:\s*/i;

// Next step (§1.7), first match wins: a "next:" note, a claimed-done
// contradiction to verify, the newest open problem, unfinished files, the last
// intent.
export function chooseNextStep(f: Omit<BriefFacts, 'nextStep'>): string | null {
  const note = [...f.notes].reverse().find((n) => NEXT_NOTE.test(n));
  if (note !== undefined) return note.replace(NEXT_NOTE, '');
  // The agent asked you something (Task 15b): answering comes first.
  if (f.lastAgent?.question)
    return `Answer ${agentName(f.lastAgent.source)}'s question: ${f.lastAgent.question}`;
  const contradiction = f.claimedDone?.contradictions[0];
  if (contradiction !== undefined) {
    // A failing command is verified by running it again.
    const command = f.openProblems.find((p) => contradictionOf(p) === contradiction)?.command;
    return command ? `Verify: \`${command}\` still failing` : `Verify: ${contradiction}`;
  }
  const problem = f.openProblems[0];
  if (problem !== undefined) return `Resolve: ${problemText(problem)}`;
  const [first, ...rest] = f.unfinished.files;
  if (first !== undefined) {
    return `Finish and commit changes in ${first.path}${rest.length > 0 ? ` and ${rest.length} more` : ''}`;
  }
  if (f.lastIntent !== null) return `Continue: ${f.lastIntent}`;
  return null;
}

const UNCOMMITTED = /^(\d+) uncommitted files?$/;
const files = (n: number) => `${n} ${n === 1 ? 'file' : 'files'}`;
const isCommitItem = (item: string) => !/^Edited \d+ files?: /.test(item);

// The problem a claim names, when its first contradiction is one.
export function claimedProblem(f: Omit<BriefFacts, 'nextStep'>): OpenProblem | null {
  const first = f.claimedDone?.contradictions[0];
  return f.openProblems.find((p) => contradictionOf(p) === first) ?? null;
}

// The next step in plain words (Task 15b): the same order as chooseNextStep,
// with failures put in words. Used by the briefs and loose ends.
export function plainNextStep(f: Omit<BriefFacts, 'nextStep'>): string | null {
  const note = [...f.notes].reverse().find((n) => NEXT_NOTE.test(n));
  if (note !== undefined) return note.replace(NEXT_NOTE, '');
  if (f.lastAgent?.question) {
    return `Answer ${agentName(f.lastAgent.source)}'s question: ${f.lastAgent.question}`;
  }
  const groups = groupProblems(f.openProblems);
  if (groups.length > 0) {
    // The claimed problem's group first, then the newest; at most three.
    const claimed = claimedProblem(f);
    const ordered = [
      ...groups.filter((g) => claimed !== null && g.problems.includes(claimed)),
      ...groups.filter((g) => claimed === null || !g.problems.includes(claimed)),
    ].slice(0, MAX_NEXT_GROUPS);
    const actions = ordered.map((g) => g.action).join(', ');
    const rerun = ordered[0]?.rerun;
    // "…, then run `x` again" unless the actions already name that command
    const again = rerun && !actions.includes(`\`${rerun}\``) ? `, then run \`${rerun}\` again` : '';
    return `${actions[0]?.toUpperCase()}${actions.slice(1)}${again}`;
  }
  if (f.claimedDone) {
    const n = Number(UNCOMMITTED.exec(f.claimedDone.contradictions[0] ?? '')?.[1] ?? 0);
    if (n > 0) {
      const agent = agentName(f.claimedDone.source);
      return `Commit the ${files(n)} ${agent} said ${n === 1 ? 'was' : 'were'} committed`;
    }
  }
  const paths = f.unfinished.files.map((file) => file.path);
  if (paths.length > 0) {
    return `Review and commit ${paths.length} uncommitted ${paths.length === 1 ? 'file' : 'files'} (${shortList(paths)})`;
  }
  if (f.done.some(isCommitItem) || f.work.commits.length > 0) {
    return 'Start the next task (everything from the last session is committed)';
  }
  return f.lastIntent !== null ? `Continue: ${f.lastIntent}` : null;
}
