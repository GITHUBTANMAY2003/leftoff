import { Command, Option } from 'commander';
import pkg from '../../package.json' with { type: 'json' };
import { logError } from '../core/logger.ts';
import { runInternalSummarizeCommand } from './commands/internal.ts';
import { runLoops } from './commands/loops.ts';
import { runNote } from './commands/note.ts';
import { runResume } from './commands/resume.ts';
import { runStandup } from './commands/standup.ts';

const program = new Command().name('leftoff').description(pkg.description).version(pkg.version);

const print = (r: { output: string; exitCode: number; stderr?: string }) => {
  if (r.stderr) process.stderr.write(r.stderr + '\n');
  process.stdout.write(r.output + '\n');
  process.exitCode = r.exitCode;
};

// Bare `leftoff` is the headline command: loose ends across all projects.
program.action(async () => print(await runLoops({ json: false })));

program
  .command('loops')
  .description('loose ends across all your projects')
  .option('--json', 'print the loose ends as JSON')
  .action(async (o: { json?: boolean }) => print(await runLoops({ json: Boolean(o.json) })));

program
  .command('resume')
  .description('show where you left off in this project')
  .option('--project <path>', 'a project other than the current folder')
  .addOption(new Option('--json', 'print the facts as JSON').conflicts('md'))
  .addOption(new Option('--md', 'print Markdown').conflicts('json'))
  .option('--polish', 'write the AI summary now (needs a polish provider from setup)')
  .action(async (o: { project?: string; json?: boolean; md?: boolean; polish?: boolean }) => {
    const format = o.json ? 'json' : o.md ? 'md' : 'terminal';
    const polish = Boolean(o.polish);
    print(await runResume({ cwd: process.cwd(), project: o.project, format, polish }));
  });

program
  .command('standup')
  .description('your standup: yesterday, today, blockers')
  .option('--since <when>', 'yesterday, today, Nh or YYYY-MM-DD (default: previous working day)')
  .option('--all', 'cover every project, not just this one')
  .option('--copy', 'also copy it to the clipboard')
  .action(async (o: { since?: string; all?: boolean; copy?: boolean }) =>
    print(
      await runStandup({
        cwd: process.cwd(),
        since: o.since,
        all: Boolean(o.all),
        copy: Boolean(o.copy),
      }),
    ),
  );

program
  .command('note')
  .description('add a note to this project (start it with "next:" to set the next step)')
  .argument('<text...>', 'the note')
  .action(async (words: string[]) => {
    await runNote(process.cwd(), words.join(' '));
    process.stdout.write('Noted.\n');
  });

// Hidden: used by hooks and background jobs.
program
  .command('internal', { hidden: true })
  .command('summarize')
  .requiredOption('--project <path>', 'the project to summarize')
  .action(async (o: { project: string }) => runInternalSummarizeCommand(o.project));

// Commands from later tasks are registered here.

try {
  await program.parseAsync(process.argv);
} catch (err) {
  logError('cli', err);
  process.stderr.write(`leftoff: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exitCode = 1;
}
