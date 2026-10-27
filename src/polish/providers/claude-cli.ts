import type { PolishProvider } from '../types.ts';
import { onPath, runCli } from './run-cli.ts';

// `claude -p`: one turn, no tools, no transcript written (R-C7). Never --bare:
// it skips keychain reads, which breaks subscription login on macOS.
const ARGS = ['-p', '--no-session-persistence', '--tools', '', '--output-format', 'text'];

export const claudeCli: PolishProvider = {
  name: 'claude-cli',
  available: () => Promise.resolve(onPath('claude')),
  polish: (prompt, timeoutMs) => runCli('claude', ARGS, prompt, timeoutMs),
};
