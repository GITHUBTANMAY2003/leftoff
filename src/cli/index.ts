import { Command, Option } from 'commander';
import pkg from '../../package.json' with { type: 'json' };
import { logError } from '../core/logger.ts';
import { runNote } from './commands/note.ts';
import { runResume } from './commands/resume.ts';

const program = new Command().name('leftoff').description(pkg.description).version(pkg.version);

program
  .command('resume')
  .description('show where you left off in this project')
  .option('--project <path>', 'a project other than the current folder')
  .addOption(new Option('--json', 'print the facts as JSON').conflicts('md'))
  .addOption(new Option('--md', 'print Markdown').conflicts('json'))
  .action(async (o: { project?: string; json?: boolean; md?: boolean }) => {
    const format = o.json ? 'json' : o.md ? 'md' : 'terminal';
    const r = await runResume({ cwd: process.cwd(), project: o.project, format, polish: false });
    process.stdout.write(r.output + '\n');
    process.exitCode = r.exitCode;
  });

program
  .command('note')
  .description('add a note to this project (start it with "next:" to set the next step)')
  .argument('<text...>', 'the note')
  .action(async (words: string[]) => {
    await runNote(process.cwd(), words.join(' '));
    process.stdout.write('Noted.\n');
  });

// Commands from later tasks are registered here.

try {
  await program.parseAsync(process.argv);
} catch (err) {
  logError('cli', err);
  process.stderr.write(`leftoff: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exitCode = 1;
}
