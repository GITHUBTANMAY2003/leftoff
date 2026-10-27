import { randomUUID } from 'node:crypto';
import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { paths } from '../../core/paths.ts';
import type { PolishProvider } from '../types.ts';
import { onPath, runCli } from './run-cli.ts';

// `codex exec`: no session files, read-only sandbox; --skip-git-repo-check
// because the cwd (~/.leftoff/tmp) is not a git repository (R-C7). The reply
// is read from the file given to -o (--output-last-message), since stdout also
// carries progress output.
export const codexCli: PolishProvider = {
  name: 'codex-cli',
  available: () => Promise.resolve(onPath('codex')),
  polish: async (prompt, timeoutMs) => {
    const reply = join(paths().tmp, `codex-${randomUUID()}.txt`);
    const args = [
      'exec',
      '--ephemeral',
      '--skip-git-repo-check',
      '-s',
      'read-only',
      '-o',
      reply,
      '-',
    ];
    try {
      await runCli('codex', args, prompt, timeoutMs);
      return readFileSync(reply, 'utf8');
    } finally {
      rmSync(reply, { force: true });
    }
  },
};
