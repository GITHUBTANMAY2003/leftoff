import { spawnSync } from 'node:child_process';
import { onPath } from '../polish/providers/run-cli.ts';

// The Claude Code plugin (R-C8): marketplace `leftoff` in this repository,
// plugin id leftoff@leftoff. `source` is the GitHub repo, or the local repo
// path while dogfooding.
const PLUGIN_ID = 'leftoff@leftoff';
const TIMEOUT_MS = 60_000;

const claude = (args: string[]) =>
  spawnSync('claude', args, { encoding: 'utf8', timeout: TIMEOUT_MS });

export function manualPluginCommands(source: string): string[] {
  return [`claude plugin marketplace add ${source}`, `claude plugin install ${PLUGIN_ID}`];
}

export async function claudePluginInstalled(): Promise<boolean> {
  if (!onPath('claude')) return false;
  const r = claude(['plugin', 'list', '--json']);
  if (r.status !== 0) return false;
  try {
    const list: unknown = JSON.parse(r.stdout);
    return (
      Array.isArray(list) &&
      list.some(
        (p) => typeof p === 'object' && p !== null && (p as { id?: unknown }).id === PLUGIN_ID,
      )
    );
  } catch {
    return false;
  }
}

export async function installClaudePlugin(
  source: string,
  print: (line: string) => void = (line) => process.stderr.write(line + '\n'),
): Promise<'installed' | 'already' | 'claude-not-found' | 'failed'> {
  if (!onPath('claude')) return 'claude-not-found';
  if (await claudePluginInstalled()) return 'already';
  for (const args of [
    ['plugin', 'marketplace', 'add', source],
    ['plugin', 'install', PLUGIN_ID],
  ]) {
    const r = claude(args);
    if (r.status !== 0) {
      print('Could not install the Claude Code plugin. Run these two commands yourself:');
      for (const command of manualPluginCommands(source)) print(`  ${command}`);
      return 'failed';
    }
  }
  return 'installed';
}
