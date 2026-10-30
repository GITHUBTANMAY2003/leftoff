import type { Source } from '../model/event.ts';
import { contradictionOf, problemText, type BriefFacts } from './facts.ts';

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
