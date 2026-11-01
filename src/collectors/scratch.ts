import { basename } from 'node:path';
import {
  chainSteps,
  displayCommand,
  normalizeCommand,
  pipelineHead,
  programWords,
} from '../model/event.ts';
import { isProbeCommand } from './probes.ts';

// Scratch work (owner decision after Task 13): one-off commands an agent runs
// to look around or to try something, not the project's own commands. Their
// failures are stored with data.scratch = true and, like probes, never become
// open problems, claimed-done contradictions or the next step.
//
// Scratch is: a multi-line command; a heredoc (`<<`); inline code run by an
// interpreter (`python -c`, `node -e`, `bash -c`, …); a pipeline whose first
// program is a text tool; a `&&` / `;` chain whose steps are all probes, scratch
// or `cd` (owner decision after Task 14). To change what counts, edit the lists below and add a
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
  if (head !== null && TEXT_TOOLS.has(basename(head))) return true;
  const steps = chainSteps(command);
  const isCd = (step: string) => /^cd(\s|$)/.test(step);
  return (
    steps.length > 1 &&
    !steps.every(isCd) &&
    steps.every((step) => isCd(step) || isProbeCommand(step) || isScratchCommand(step))
  );
}

// A command that touches a temp folder (/tmp, /private/tmp, /var/folders, an
// agent's scratchpad, $TMPDIR, mktemp) is scratch from any source, your shell
// included: nothing there belongs to the project (Task 15b).
const TEMP_DIR =
  /(^|[\s'"=:(])(\/private)?\/tmp(\/|\s|$)|\/var\/folders\/|\/scratchpad(\/|\s|$)|\$\{?TMPDIR\b|\bmktemp\b/;
export function referencesTempDir(command: string): boolean {
  return TEMP_DIR.test(command);
}

// The agent's tool was refused, blocked or misused (Task 15b): an error of the
// agent's harness, never a problem of the project.
const AGENT_TOOL_ERRORS = [
  /<tool_use_error>/,
  /^\s*Blocked:/m,
  /The user doesn't want to proceed with this tool use/,
  /\bPermission to use \S+.* (has been|was) denied\b/,
  /\brejected by (the )?user\b/i,
  /\[Request interrupted by user/,
];
export function isAgentToolError(text: string): boolean {
  return AGENT_TOOL_ERRORS.some((p) => p.test(text));
}

// Long-running processes (owner decision after Task 15c): servers, dev
// servers, watchers and `tail -f`. Stopping one with a signal (130 Ctrl-C,
// 137 kill, 143 terminate) is how they end, not a failure, from any source.
const LONG_RUNNING_WORDS = new Set([
  'serve',
  'server',
  'runserver',
  'dev',
  'start',
  'watch',
  'preview',
  'up',
  'develop',
]);
const LONG_RUNNING_PROGRAMS = new Set([
  'uvicorn',
  'gunicorn',
  'hypercorn',
  'nodemon',
  'http-server',
  'live-server',
]);
const STOP_SIGNALS = new Set([130, 137, 143]);

export function isLongRunning(command: string): boolean {
  const words = programWords(command) ?? normalizeCommand(command).split(' ');
  const [program = '', ...rest] = words;
  if (LONG_RUNNING_PROGRAMS.has(basename(program))) return true;
  if (program === 'tail' && rest.some((w) => /^-[a-zA-Z]*[fF]/.test(w))) return true;
  if (words.slice(0, 4).some((w) => LONG_RUNNING_WORDS.has(w) || /\.server$/.test(w))) return true;
  return rest.some(
    (w) => w === '--watch' || w === '--port' || w === '--host' || w.startsWith('--port='),
  );
}

export function isStoppedLongRunning(command: string, exitCode: number): boolean {
  return STOP_SIGNALS.has(exitCode) && isLongRunning(command);
}

// leftoff's own commands (dogfooding after Task 15c): `leftoff …`, the shim,
// or the built CLI run with node. Never recorded, never a problem or activity.
export function isLeftoffCommand(command: string): boolean {
  return chainSteps(displayCommand(command)).some((step) => {
    const [program = '', script = ''] = programWords(step) ?? normalizeCommand(step).split(' ');
    if (basename(program) === 'leftoff') return true;
    return /^node(js)?$/.test(basename(program)) && /(^|\/)leftoff\/dist\/cli\.js$/.test(script);
  });
}

// Commands that only look around (dogfooding after Task 15c): they don't make
// a project "last worked on". Probes, scratch, and read-only git and shell.
const LOOK_AROUND =
  /^(git (status|log|show|diff|branch|remote|fetch|stash list|blame|reflog)|clear|cd|pushd|popd|history|exit|man|tldr|open|code|cursor|z)(\s|$)/;
export function isLookAround(command: string): boolean {
  const shown = displayCommand(command);
  return (
    isLeftoffCommand(command) ||
    isProbeCommand(shown) ||
    isScratchCommand(command) ||
    LOOK_AROUND.test(shown)
  );
}
