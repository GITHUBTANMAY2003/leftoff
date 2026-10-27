import { basename } from 'node:path';
import { normalizeCommand, pipelineHead } from '../model/event.ts';

// Scratch work (owner decision after Task 13): one-off commands an agent runs
// to look around or to try something, not the project's own commands. Their
// failures are stored with data.scratch = true and, like probes, never become
// open problems, claimed-done contradictions or the next step.
//
// Scratch is: a multi-line command; a heredoc (`<<`); inline code run by an
// interpreter (`python -c`, `node -e`, `bash -c`, …); a pipeline whose first
// program is a text tool. To change what counts, edit the lists below and add a
// case to tests/collectors/scratch.test.ts.

const INLINE_CODE: Record<string, string[]> = {
  python: ['-c'],
  python3: ['-c'],
  node: ['-e', '--eval', '-p', '--print'],
  bash: ['-c'],
  sh: ['-c'],
  zsh: ['-c'],
};
const TEXT_TOOLS = new Set([
  'grep',
  'egrep',
  'fgrep',
  'rg',
  'ag',
  'sed',
  'awk',
  'gawk',
  'jq',
  'yq',
  'find',
  'fd',
  'cat',
  'head',
  'tail',
  'ls',
  'wc',
  'sort',
  'uniq',
  'cut',
  'tr',
  'echo',
  'printf',
  'xargs',
  'diff',
  'column',
  'nl',
]);

export function isScratchCommand(raw: string): boolean {
  const command = raw.trim();
  if (command.includes('\n')) return true;
  if (/<<-?\s*['"]?[A-Za-z_]/.test(command)) return true;
  const [program = '', flag = ''] = normalizeCommand(command).split(' ');
  if (INLINE_CODE[basename(program)]?.includes(flag)) return true;
  const head = pipelineHead(command);
  return head !== null && TEXT_TOOLS.has(basename(head));
}
