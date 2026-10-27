import type { BriefFacts } from './facts.ts';

const NEXT_NOTE = /^next:\s*/i;

// Next step (§1.7), first match wins: a "next:" note, a claimed-done
// contradiction to verify, the newest open problem, unfinished files, the last
// intent.
export function chooseNextStep(f: Omit<BriefFacts, 'nextStep'>): string | null {
  const note = [...f.notes].reverse().find((n) => NEXT_NOTE.test(n));
  if (note !== undefined) return note.replace(NEXT_NOTE, '');
  const contradiction = f.claimedDone?.contradictions[0];
  if (contradiction !== undefined) return `Verify: ${contradiction}`;
  const problem = f.openProblems[0];
  if (problem !== undefined) return `Resolve: ${problem.error}`;
  const [first, ...rest] = f.unfinished.files;
  if (first !== undefined) {
    return `Finish and commit changes in ${first.path}${rest.length > 0 ? ` and ${rest.length} more` : ''}`;
  }
  if (f.lastIntent !== null) return `Continue: ${f.lastIntent}`;
  return null;
}
