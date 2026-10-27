// Interactive questions for setup, forget and uninstall (plan Task 15). Tests
// pass a scripted implementation; the real one reads from the terminal.
export interface Prompter {
  confirm(question: string, def: boolean): Promise<boolean>;
  choose<T extends string>(question: string, options: T[], def: T): Promise<T>;
  input(question: string, def?: string): Promise<string>;
  say(line: string): void; // an explanation or result line, shown as it happens
}

// The real prompter: questions go to stderr-free stdout, answers come from stdin.
export async function terminalPrompter(): Promise<Prompter & { close(): void }> {
  const { createInterface } = await import('node:readline/promises');
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return {
    async confirm(question, def) {
      const answer = (await rl.question(`${question} [${def ? 'Y/n' : 'y/N'}] `))
        .trim()
        .toLowerCase();
      return answer === '' ? def : answer.startsWith('y');
    },
    async choose(question, options, def) {
      const list = options.map((o) => (o === def ? `${o} (default)` : o)).join(', ');
      for (;;) {
        const answer = (await rl.question(`${question}\n  ${list}\n> `)).trim();
        if (answer === '') return def;
        const hit = options.find((o) => o === answer);
        if (hit !== undefined) return hit;
        process.stdout.write(`  Please type one of: ${options.join(', ')}\n`);
      }
    },
    async input(question, def) {
      const answer = (await rl.question(`${question}${def ? ` [${def}]` : ''} `)).trim();
      return answer === '' ? (def ?? '') : answer;
    },
    say: (line) => {
      process.stdout.write(line + '\n');
    },
    close: () => rl.close(),
  };
}
