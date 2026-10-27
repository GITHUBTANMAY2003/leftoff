import type { BriefFacts } from '../brief/facts.ts';

// The polish prompt (spec §1.9): the instruction, then the BriefFacts JSON.
export const MAX_FACTS_CHARS = 8000;
const MAX_POLISH_CHARS = 1200;

const INSTRUCTION = `Rewrite these facts about a developer's recent work into a short paragraph, at most 4 sentences, telling them where they left off. Use only what the facts say: add nothing that is not in the facts. Reply with the paragraph only.

Facts (JSON):
`;

const json = (f: unknown) => JSON.stringify(f, null, 1);
const cut = (s: string | null, n: number) => (s !== null && s.length > n ? `${s.slice(0, n)}…` : s);

// Smaller and smaller versions of the facts: first without the source list,
// then with shorter lists, then with shorter texts. The first that fits wins.
function* shrunk(f: BriefFacts): Generator<unknown> {
  const base = { ...f, sources: undefined };
  yield base;
  for (const n of [10, 5, 3, 1]) {
    const lists = {
      ...base,
      done: f.done.slice(0, n),
      notes: f.notes.slice(-n),
      unfinished: { ...f.unfinished, files: f.unfinished.files.slice(0, n) },
      openProblems: f.openProblems
        .slice(0, n)
        .map((p) => ({ ...p, attempts: p.attempts.slice(0, n) })),
    };
    yield lists;
    for (const chars of [300, 100]) {
      yield {
        ...lists,
        done: lists.done.map((d) => cut(d, chars)),
        notes: lists.notes.map((d) => cut(d, chars)),
        lastIntent: cut(f.lastIntent, chars),
        lastAgentMessage: cut(f.lastAgentMessage, chars),
        openProblems: lists.openProblems.map((p) => ({
          ...p,
          error: cut(p.error, chars),
          attempts: p.attempts.map((a) => cut(a, chars)),
        })),
        claimedDone: f.claimedDone && {
          ...f.claimedDone,
          message: cut(f.claimedDone.message, chars),
        },
      };
    }
  }
}

export function buildPolishPrompt(f: BriefFacts): string {
  let smallest = '';
  for (const version of shrunk(f)) {
    smallest = json(version);
    if (smallest.length <= MAX_FACTS_CHARS) break;
  }
  return INSTRUCTION + smallest;
}

// Trimmed text, or null when it is empty or longer than 1200 characters.
export function validatePolish(text: string): string | null {
  const t = text.trim();
  return t === '' || t.length > MAX_POLISH_CHARS ? null : t;
}
