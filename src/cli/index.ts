import { Command } from 'commander';
import pkg from '../../package.json' with { type: 'json' };
import { logError } from '../core/logger.ts';

const program = new Command().name('leftoff').description(pkg.description).version(pkg.version);

// Commands are registered here by later tasks.

try {
  await program.parseAsync(process.argv);
} catch (err) {
  logError('cli', err);
  process.stderr.write(`leftoff: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exitCode = 1;
}
