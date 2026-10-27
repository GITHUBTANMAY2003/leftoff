import { contradictionOf, type BriefFacts, type OpenProblem } from '../brief/facts.ts';

// A problem already shown under "Agent said done, but" is not repeated under
// "Open problems"; its attempts move with it (owner decision after Task 10).
// Used by the terminal and Markdown briefs; the agent context and JSON keep
// every open problem.
export function splitProblems(f: BriefFacts): {
  claimed: { text: string; attempts: string[] }[];
  open: OpenProblem[];
} {
  const contradictions = f.claimedDone?.contradictions ?? [];
  const byContradiction = new Map(f.openProblems.map((p) => [contradictionOf(p), p]));
  return {
    claimed: contradictions.map((text) => ({
      text,
      attempts: byContradiction.get(text)?.attempts ?? [],
    })),
    open: f.openProblems.filter((p) => !contradictions.includes(contradictionOf(p))),
  };
}
