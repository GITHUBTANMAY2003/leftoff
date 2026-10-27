import type { BriefFacts } from '../brief/facts.ts';

// `leftoff resume --json`: the facts and the polished text (or null), for scripts.
export function renderJson(f: BriefFacts, polished: string | null): string {
  return JSON.stringify({ facts: f, polished }, null, 2);
}
