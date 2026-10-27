import { normalizeCommand } from '../model/event.ts';
import { looksLikeTestFailure } from './test-failures.ts';

// Probes (owner decision after Task 9): commands that look around and "fail" by
// design (a search with no match, a missing file). Their failures are stored
// with data.probe = true and kept in the database, but they are not open
// problems or claimed-done contradictions. Deterministic, one place: add a
// command here with a test in tests/collectors/probes.test.ts.

// Programs, and "program subcommand" pairs, that only read.
export const PROBE_COMMANDS = [
  'ls',
  'cat',
  'head',
  'tail',
  'stat',
  'test',
  '[',
  'which',
  'command -v',
  'type',
  'grep',
  'rg',
  'ag',
  'find',
  'fd',
  'git show',
  'git rev-parse',
  'git ls-files',
  'git cat-file',
  // exit 1 means "differences found" (owner decision after Task 13)
  'git diff',
  'diff',
  'cmp',
  // read-only look-around commands (owner decision after Task 14)
  'sed -n', // -i writes, so only the printing form
  'lsof',
  'ps',
  'pwd',
  'echo',
  'printenv',
  'date',
  'uname',
  'whoami',
];

// `env` alone only prints; with arguments it runs a command.
// `<tool> --version`, `-V` and `--help` only print (a missing tool exits 127,
// which is still a real problem).
const INFO_FLAGS = new Set(['--version', '-V', '--help']);

// Read-only agent tools. Codex (0.163) has none of its own: it reads and
// searches through shell commands, which PROBE_COMMANDS covers.
const READ_ONLY_TOOLS = new Set(['Read', 'Glob', 'Grep', 'LS']);

// Exit codes that mean "not found / no match / differs" for these programs.
// Anything else (126 not executable, 127 not found, 128 git fatal, 130
// interrupted, …) is a real failure.
const PROBE_EXIT_CODES = new Set([1, 2]);

const SEPARATOR = /\s*(?:&&|\|\||;|\|)\s*/;

function isProbePart(part: string): boolean {
  const words = normalizeCommand(part).split(' ');
  if (words.length === 1 && words[0] === 'env') return true;
  if (words.slice(1, 3).some((w) => INFO_FLAGS.has(w))) return true;
  return PROBE_COMMANDS.some((probe) => {
    const p = probe.split(' ');
    return p.every((w, i) => words[i] === w);
  });
}

// True when every part of the command line is a probe (`cd` steps allowed):
// `cat a && cat b` and `rg x | head` are probes; `ls && npm run build` is not.
export function isProbeCommand(command: string): boolean {
  const parts = normalizeCommand(command)
    .split(SEPARATOR)
    .filter((p) => p !== '' && !/^cd(\s|$)/.test(p));
  return parts.length > 0 && parts.every(isProbePart);
}

export function isProbeFailure(command: string, exitCode: number, output: string): boolean {
  return isProbeCommand(command) && PROBE_EXIT_CODES.has(exitCode) && !looksLikeTestFailure(output);
}

export function isReadOnlyTool(tool: string | null | undefined): boolean {
  return typeof tool === 'string' && READ_ONLY_TOOLS.has(tool);
}
