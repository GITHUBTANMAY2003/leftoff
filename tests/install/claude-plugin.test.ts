import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, expect, test } from 'vitest';
import {
  claudePluginInstalled,
  installClaudePlugin,
  manualPluginCommands,
} from '../../src/install/claude-plugin.ts';

const ROOT = resolve(import.meta.dirname, '../..');
const HOOK_NAMES = ['claude-session-start', 'claude-stop', 'claude-session-end'];

let tmp: string;
let bin: string;
const KEYS = ['PATH', 'HOME', 'LEFTOFF_HOME', 'FAKE_OUT', 'FAKE_LIST', 'FAKE_FAIL'] as const;
const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));

beforeEach(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), 'leftoff-plugin-')));
  bin = join(tmp, 'bin');
  mkdirSync(bin);
  process.env.PATH = `${bin}:/usr/bin:/bin`; // never the real claude
  process.env.FAKE_OUT = join(tmp, 'calls');
});

afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  rmSync(tmp, { recursive: true, force: true });
});

const readJson = (rel: string) => JSON.parse(readFileSync(join(ROOT, rel), 'utf8'));
interface HookEntry {
  matcher?: string;
  hooks: { type: string; command: string; timeout: number }[];
}

test('hooks.json is valid and references the three hooks', () => {
  const { hooks } = readJson('plugin/hooks/hooks.json') as { hooks: Record<string, HookEntry[]> };
  expect(Object.keys(hooks).sort()).toEqual(['SessionEnd', 'SessionStart', 'Stop']);
  const [start] = hooks.SessionStart as HookEntry[];
  expect(start?.matcher).toBe('startup|clear|compact'); // resume and fork excluded (R-C2)
  const commandOf = (event: string) => (hooks[event] as HookEntry[])[0]?.hooks[0];
  expect(commandOf('SessionStart')).toMatchObject({ type: 'command', timeout: 5 });
  expect(commandOf('Stop')).toMatchObject({ type: 'command', timeout: 2 });
  expect(commandOf('SessionEnd')).toMatchObject({ type: 'command', timeout: 2 });
  expect(commandOf('SessionStart')?.command).toContain('hook claude-session-start');
  expect(commandOf('Stop')?.command).toContain('hook claude-stop');
  expect(commandOf('SessionEnd')?.command).toContain('hook claude-session-end');
});

test('plugin and marketplace manifests: plugin id leftoff@leftoff from ./plugin', () => {
  expect(readJson('plugin/.claude-plugin/plugin.json')).toMatchObject({ name: 'leftoff' });
  const market = readJson('.claude-plugin/marketplace.json');
  expect(market.name).toBe('leftoff');
  expect(market.plugins).toEqual([
    expect.objectContaining({ name: 'leftoff', source: './plugin' }),
  ]);
});

// Runs the exact command string from hooks.json under sh, the way Claude Code does.
function runHookCommand(name: string, env: Record<string, string>) {
  const { hooks } = readJson('plugin/hooks/hooks.json') as { hooks: Record<string, HookEntry[]> };
  const event = {
    'claude-session-start': 'SessionStart',
    'claude-stop': 'Stop',
    'claude-session-end': 'SessionEnd',
  }[name] as string;
  const command = (hooks[event] as HookEntry[])[0]?.hooks[0]?.command as string;
  return spawnSync('sh', ['-c', command], { env, input: '{}', encoding: 'utf8' });
}
function recorder(file: string, label: string): void {
  writeFileSync(file, `#!/bin/sh\necho "${label} $*" >> "$FAKE_OUT"\necho "${label}-output"\n`);
  chmodSync(file, 0o755);
}

test('hook command uses the shim when present, falls back to PATH, exits 0 when neither exists', () => {
  const home = join(tmp, 'home');
  const env = { HOME: home, PATH: `${bin}:/usr/bin:/bin`, FAKE_OUT: join(tmp, 'calls') };
  for (const name of HOOK_NAMES) {
    // Neither: silent, exit 0.
    const none = runHookCommand(name, env);
    expect([none.status, none.stdout, none.stderr]).toEqual([0, '', '']);
  }
  // On PATH only.
  recorder(join(bin, 'leftoff'), 'path');
  expect(runHookCommand('claude-stop', env)).toMatchObject({ status: 0, stdout: 'path-output\n' });
  // The shim wins over PATH (default location under $HOME).
  mkdirSync(join(home, '.leftoff', 'bin'), { recursive: true });
  recorder(join(home, '.leftoff', 'bin', 'leftoff'), 'shim');
  expect(runHookCommand('claude-session-start', env)).toMatchObject({
    status: 0,
    stdout: 'shim-output\n',
  });
  // LEFTOFF_HOME moves the shim.
  const lhome = join(tmp, 'lhome');
  mkdirSync(join(lhome, 'bin'), { recursive: true });
  recorder(join(lhome, 'bin', 'leftoff'), 'lhome');
  runHookCommand('claude-session-end', { ...env, LEFTOFF_HOME: lhome });
  expect(readFileSync(join(tmp, 'calls'), 'utf8').split('\n')).toEqual([
    'path hook claude-stop',
    'shim hook claude-session-start',
    'lhome hook claude-session-end',
    '',
  ]);
  // A failing leftoff still exits 0.
  writeFileSync(join(home, '.leftoff', 'bin', 'leftoff'), '#!/bin/sh\nexit 7\n');
  expect(runHookCommand('claude-stop', env).status).toBe(0);
}, 20_000); // seven sh runs: slow on a loaded CI machine

// A fake `claude`: records each call; `plugin list --json` prints $FAKE_LIST;
// a call whose arguments contain $FAKE_FAIL exits 1.
function fakeClaude(): void {
  const file = join(bin, 'claude');
  writeFileSync(
    file,
    `#!/bin/sh
echo "$*" >> "$FAKE_OUT"
case "$*" in *"$FAKE_FAIL"*) [ -n "$FAKE_FAIL" ] && { echo "boom" >&2; exit 1; } ;; esac
[ "$*" = "plugin list --json" ] && printf '%s' "$FAKE_LIST"
exit 0
`,
  );
  chmodSync(file, 0o755);
}
const calls = () =>
  existsSync(join(tmp, 'calls')) ? readFileSync(join(tmp, 'calls'), 'utf8').trim().split('\n') : [];
const LIST_WITH = JSON.stringify([{ id: 'other@x' }, { id: 'leftoff@leftoff', enabled: true }]);
const LIST_WITHOUT = JSON.stringify([{ id: 'other@x' }]);

test('claude not on PATH → claude-not-found, not installed', async () => {
  expect(await claudePluginInstalled()).toBe(false);
  expect(await installClaudePlugin('/repo')).toBe('claude-not-found');
});

test('already installed → already, no install commands run', async () => {
  fakeClaude();
  process.env.FAKE_LIST = LIST_WITH;
  expect(await claudePluginInstalled()).toBe(true);
  expect(await installClaudePlugin('/repo')).toBe('already');
  expect(calls()).toEqual(['plugin list --json', 'plugin list --json']);
});

test('not installed → marketplace add <source>, then install leftoff@leftoff', async () => {
  fakeClaude();
  process.env.FAKE_LIST = LIST_WITHOUT;
  expect(await installClaudePlugin('/path/to/leftoff')).toBe('installed');
  expect(calls()).toEqual([
    'plugin list --json',
    'plugin marketplace add /path/to/leftoff',
    'plugin install leftoff@leftoff',
  ]);
});

test('a failing step → failed, and the two commands are printed for the user', async () => {
  fakeClaude();
  process.env.FAKE_LIST = LIST_WITHOUT;
  process.env.FAKE_FAIL = 'install';
  const printed: string[] = [];
  expect(await installClaudePlugin('GITHUBTANMAY2003/leftoff', (l) => printed.push(l))).toBe(
    'failed',
  );
  expect(manualPluginCommands('GITHUBTANMAY2003/leftoff')).toEqual([
    'claude plugin marketplace add GITHUBTANMAY2003/leftoff',
    'claude plugin install leftoff@leftoff',
  ]);
  expect(printed.join('\n')).toContain('claude plugin marketplace add GITHUBTANMAY2003/leftoff');
  expect(printed.join('\n')).toContain('claude plugin install leftoff@leftoff');
});

test('unreadable plugin list output → not installed', async () => {
  fakeClaude();
  process.env.FAKE_LIST = 'not json';
  expect(await claudePluginInstalled()).toBe(false);
});
