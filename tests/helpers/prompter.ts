import type { Prompter } from '../../src/cli/prompter.ts';

// A prompter that answers from a script, in order, and records what it was asked.
// Each answer is a boolean (confirm), a string (choose, input), or undefined to
// take the default.
export function scripted(answers: (boolean | string | undefined)[] = []) {
  const asked: string[] = [];
  const said: string[] = [];
  const next = () => answers.shift();
  const io: Prompter = {
    confirm: async (q, def) => {
      asked.push(q);
      const a = next();
      return typeof a === 'boolean' ? a : def;
    },
    choose: async (q, options, def) => {
      asked.push(q);
      const a = next();
      if (a !== undefined && !options.includes(a as never)) {
        throw new Error(`scripted answer "${String(a)}" is not one of ${options.join(', ')}`);
      }
      return (typeof a === 'string' ? a : def) as never;
    },
    input: async (q, def = '') => {
      asked.push(q);
      const a = next();
      return typeof a === 'string' ? a : def;
    },
    say: (line) => {
      said.push(line);
    },
  };
  return { io, asked, said, remaining: () => answers.length };
}
