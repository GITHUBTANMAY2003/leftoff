import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { ensureHome, paths } from '../core/paths.ts';

export type ShellName = 'zsh' | 'bash' | 'fish';

const SHELLS: ShellName[] = ['zsh', 'bash', 'fish'];
const BEGIN = '# >>> leftoff >>>';
const END = '# <<< leftoff <<<';
const BLOCK = /# >>> leftoff >>>\n[\s\S]*?# <<< leftoff <<<\n?/;
const BLOCK_WITH_SEPARATOR = new RegExp(`\\n?${BLOCK.source}`);

// Copies the hook scripts into LEFTOFF_HOME/shell/ (R-B8), so rc files point at
// a path that survives Node version switches and reinstalls. The first line
// records the version for `leftoff doctor`.
export function installShellScripts(packageShellDir: string, version: string): void {
  ensureHome();
  for (const shell of SHELLS) {
    const body = readFileSync(join(packageShellDir, `leftoff.${shell}`), 'utf8');
    const dest = join(paths().shellDir, `leftoff.${shell}`);
    writeFileSync(dest, `# leftoff ${version}\n${body}`, { mode: 0o600 });
    chmodSync(dest, 0o600); // `mode` above only applies when the file is created
  }
}

export function installedShellScriptVersion(shell: ShellName): string | null {
  try {
    const first = readFileSync(join(paths().shellDir, `leftoff.${shell}`), 'utf8').split(
      '\n',
      1,
    )[0];
    return /^# leftoff (\S+)$/.exec(first ?? '')?.[1] ?? null;
  } catch {
    return null;
  }
}

// Double-quoted for the target shell. fish only treats \ " $ as special there.
function quote(shell: ShellName, path: string): string {
  const special = shell === 'fish' ? /[\\"$]/g : /[\\"$`]/g;
  return `"${path.replace(special, '\\$&')}"`;
}

function block(shell: ShellName, scriptPath: string): string {
  const q = quote(shell, scriptPath);
  // Guarded, so a missing script never prints an error in a new terminal (D10).
  const source = shell === 'fish' ? `test -r ${q}; and source ${q}` : `[ -r ${q} ] && . ${q}`;
  return `${BEGIN}\n${source}\n${END}\n`;
}

// Writes in place (not temp file + rename) so an rc file that is a symlink into
// a dotfiles repo stays a symlink.
export function installShellHook(
  shell: ShellName,
  rcPath: string,
  scriptPath: string,
): 'installed' | 'already' {
  const wanted = block(shell, scriptPath);
  const current = existsSync(rcPath) ? readFileSync(rcPath, 'utf8') : '';
  if (current.includes(wanted)) return 'already';
  let next: string;
  if (BLOCK.test(current)) {
    next = current.replace(BLOCK, wanted); // the script path changed
  } else {
    next = current;
    if (next !== '' && !next.endsWith('\n')) next += '\n';
    if (next !== '') next += '\n'; // blank line before our block
    next += wanted;
  }
  mkdirSync(dirname(rcPath), { recursive: true });
  writeFileSync(rcPath, next);
  return 'installed';
}

// Removes the block and the blank line installShellHook put before it.
export function removeShellHook(rcPath: string): boolean {
  if (!existsSync(rcPath)) return false;
  const current = readFileSync(rcPath, 'utf8');
  if (!BLOCK.test(current)) return false;
  writeFileSync(rcPath, current.replace(BLOCK_WITH_SEPARATOR, ''));
  return true;
}
