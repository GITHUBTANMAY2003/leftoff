import { Command, Option } from 'commander';
import pkg from '../../package.json' with { type: 'json' };
import { logError } from '../core/logger.ts';
import { runBriefAuto } from './commands/brief-auto.ts';
import { runConfig } from './commands/config.ts';
import { renderDoctor, runDoctor } from './commands/doctor.ts';
import { runForget } from './commands/forget.ts';
import { detectSetupEnv, runSetup } from './commands/setup.ts';
import { runStatus } from './commands/status.ts';
import { runUninstall } from './commands/uninstall.ts';
import { terminalPrompter } from './prompter.ts';
import { runHook, type HookName } from './commands/hook.ts';
import { runInternalIngestCommand, runInternalSummarizeCommand } from './commands/internal.ts';
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
    const notify = (line: string) => process.stderr.write(line + '\n');
    print(await runResume({ cwd: process.cwd(), project: o.project, format, polish, notify }));
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

program
  .command('status')
  .description('tracked projects, the last ingest per collector, event counts')
  .action(async () => {
    process.stdout.write((await runStatus()) + '\n');
  });

program
  .command('forget')
  .description(
    'delete stored data (all events, cached briefs and shown markers); read positions ' +
      '(file paths and offsets, no content) are kept so forgotten history is not read in again',
  )
  .option('--project <path>', 'forget one project')
  .option('--all', 'forget everything')
  .option('--yes', 'do not ask for confirmation')
  .action(async (o: { project?: string; all?: boolean; yes?: boolean }) => {
    const io = await terminalPrompter();
    try {
      const output = await runForget(
        {
          ...(o.project !== undefined ? { project: o.project } : {}),
          all: Boolean(o.all),
          yes: Boolean(o.yes),
        },
        io,
      );
      process.stdout.write(output + '\n');
      if (output.startsWith('Use --project')) process.exitCode = 1;
    } finally {
      io.close();
    }
  });

program
  .command('config')
  .description('read or change settings: list | get <key> | set <key> <value>')
  .argument('[args...]', 'list, get <key>, or set <key> <value>')
  .allowUnknownOption()
  .action(async (args: string[]) => print(await runConfig(args)));

program
  .command('setup')
  .description('install the shell hook, the Claude Code plugin and choose AI summaries')
  .action(async () => {
    const io = await terminalPrompter();
    try {
      await runSetup(io, detectSetupEnv());
    } finally {
      io.close();
    }
  });

program
  .command('doctor')
  .description('check that everything works, with a fix hint for each problem')
  .action(async () => {
    const result = await runDoctor();
    process.stdout.write(renderDoctor(result) + '\n');
    process.exitCode = result.exitCode;
  });

program
  .command('uninstall')
  .description('remove the shell hook blocks and print the plugin removal commands')
  .action(async () => {
    const io = await terminalPrompter();
    try {
      process.stdout.write((await runUninstall(io)) + '\n');
    } finally {
      io.close();
    }
  });

// Hook input on stdin; '' for a terminal, and at most 1 s of waiting.
function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return Promise.resolve('');
  return new Promise((resolve) => {
    let data = '';
    const done = () => resolve(data);
    setTimeout(done, 1000).unref();
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk: string) => (data += chunk));
    process.stdin.on('end', done);
    process.stdin.on('error', done);
  });
}

// Hidden: used by hooks and background jobs.
program
  .command('hook', { hidden: true })
  .argument('<name>')
  .action(async (name: string) => {
    const { stdout } = await runHook(name as HookName, await readStdin());
    // Exit now: work abandoned past the hook's budget must not keep it running.
    process.stdout.write(stdout, () => process.exit(0));
  });

program
  .command('brief', { hidden: true })
  .requiredOption('--auto', 'the short brief the shell hook prints on terminal open')
  .action(async () => {
    const out = await runBriefAuto(process.cwd());
    // Exit now: the background ingest it may start is detached.
    process.stdout.write(out ? out + '\n' : '', () => process.exit(0));
  });

const internal = program.command('internal', { hidden: true });
internal
  .command('summarize')
  .requiredOption('--project <path>', 'the project to summarize')
  .action(async (o: { project: string }) => runInternalSummarizeCommand(o.project));
internal.command('ingest').action(async () => runInternalIngestCommand());

// Commands from later tasks are registered here.

try {
  await program.parseAsync(process.argv);
} catch (err) {
  logError('cli', err);
  process.stderr.write(`leftoff: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exitCode = 1;
}
