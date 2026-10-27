import { existsSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, relative } from 'node:path';
import { claudeDir } from '../../collectors/claude.ts';
import { paths } from '../../core/paths.ts';
import { removeShellHook, rcPathFor, type ShellName } from '../../install/shell-rc.ts';
import type { Prompter } from '../prompter.ts';

// `leftoff uninstall` (§1.10): removes the rc blocks, prints the plugin
// uninstall commands, asks before deleting data. Nothing else is deleted: the
// folder `claude -p` polish runs leave behind is only named (owner decision
// after Task 12).
const SHELLS: ShellName[] = ['zsh', 'bash', 'fish'];

// Claude Code names a project's folder after its path, every character that
// isn't a letter or digit turned into "-".
function polishLeftoverFolder(): string {
  return join(claudeDir(), 'projects', paths().tmp.replace(/[^A-Za-z0-9]/g, '-'));
}

export async function runUninstall(io: Prompter, opts: { home?: string } = {}): Promise<string> {
  const home = opts.home ?? homedir();
  const lines: string[] = [];
  let removed = 0;
  for (const shell of SHELLS) {
    const rc = rcPathFor(shell, home);
    if (removeShellHook(rc)) {
      removed++;
      lines.push(`Removed the leftoff block from ~/${relative(home, rc)}`);
    }
  }
  if (removed === 0) lines.push('No leftoff block found in your shell files.');

  lines.push(
    '',
    'To remove the Claude Code plugin, run:',
    '  claude plugin uninstall leftoff@leftoff',
    '  claude plugin marketplace remove leftoff',
  );

  const leftover = polishLeftoverFolder();
  if (existsSync(leftover)) {
    lines.push(
      '',
      'AI summaries with `claude -p` left an empty folder in Claude Code (no transcript).',
      `Not deleted: ${leftover}`,
      `To remove it: rm -r '${leftover}'`,
    );
  }

  const data = paths().home;
  lines.push('');
  if (await io.confirm(`Also delete all leftoff data in ${data}?`, false)) {
    rmSync(data, { recursive: true, force: true });
    lines.push(`Deleted ${data}.`);
  } else {
    lines.push(`Your data is still in ${data}. To delete it later: rm -r '${data}'`);
  }
  return lines.join('\n');
}
