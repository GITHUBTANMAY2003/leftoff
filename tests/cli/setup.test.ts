import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { expect, test } from 'vitest';
import pkg from '../../package.json' with { type: 'json' };
import { runSetup, type SetupEnv } from '../../src/cli/commands/setup.ts';
import { loadConfig } from '../../src/core/config.ts';
import { paths } from '../../src/core/paths.ts';
import type { IngestReport } from '../../src/ingest/ingest.ts';
import { installedShellScriptVersion } from '../../src/install/shell-rc.ts';
import { shimStatus } from '../../src/install/shim.ts';
import { scripted } from '../helpers/prompter.ts';
import { useTempHome } from '../helpers/home.ts';

const t = useTempHome();
const SHELL_DIR = resolve(import.meta.dirname, '../../shell');

function env(over: Partial<SetupEnv> = {}): SetupEnv {
  const cli = join(t.tmp, 'cli.mjs');
  writeFileSync(cli, 'console.log("0.0.0")\n');
  return {
    home: t.home,
    shell: '/bin/zsh',
    hasClaude: false,
    hasCodex: false,
    hasOllama: false,
    cliPath: cli,
    shellDir: SHELL_DIR,
    pluginSource: '/repo',
    ...over,
  };
}
const zshrc = () => join(t.home, '.zshrc');
const report = (over: Partial<Record<string, number>> = {}): IngestReport => ({
  prunedEvents: 0,
  perSource: {
    claude: { status: 'ok', inserted: over.claude ?? 0, warnings: [] },
    codex: { status: 'ok', inserted: over.codex ?? 0, warnings: [] },
    shell: { status: 'ok', inserted: over.shell ?? 0, warnings: [] },
    git: { status: 'ok', inserted: over.git ?? 0, warnings: [] },
  },
});
const noIngest = { ingest: async () => report() };

test('setup with scripted answers installs the zsh hook, writes config and the shim', async () => {
  writeFileSync(zshrc(), 'export A=1\n');
  const { io, said } = scripted([true, 'off']);
  const result = await runSetup(io, env({ ...noIngest }));
  expect(result.shellHooks).toEqual({ zsh: 'installed' });
  const rc = readFileSync(zshrc(), 'utf8');
  expect(rc.startsWith('export A=1\n')).toBe(true);
  expect(rc).toContain('# >>> leftoff >>>');
  expect(rc).toContain(`. "${join(paths().shellDir, 'leftoff.zsh')}"`);
  expect(existsSync(paths().config)).toBe(true);
  expect(statSync(paths().home).mode & 0o777).toBe(0o700);
  expect(loadConfig().polish.provider).toBe('off');
  expect(said.at(-1)).toBe(
    'To undo: run `leftoff uninstall` (it removes the hooks and asks before deleting any data)',
  );
});

test('setup writes the shim and copies shell scripts on every run', async () => {
  await runSetup(scripted([true, 'off']).io, env({ ...noIngest }));
  expect(shimStatus().works).toBe(true);
  expect(installedShellScriptVersion('zsh')).toBe(pkg.version);
  expect(installedShellScriptVersion('bash')).toBe(pkg.version);
  expect(installedShellScriptVersion('fish')).toBe(pkg.version);
  rmSync(paths().shim);
  writeFileSync(join(paths().shellDir, 'leftoff.zsh'), '# leftoff 0.0.0-old\n');
  await runSetup(scripted([true, 'off']).io, env({ ...noIngest }));
  expect(shimStatus().works).toBe(true);
  expect(installedShellScriptVersion('zsh')).toBe(pkg.version);
});

test('setup is idempotent: a second run changes nothing and says "already"', async () => {
  writeFileSync(zshrc(), 'export A=1\n');
  await runSetup(scripted([true, 'off']).io, env({ ...noIngest }));
  const before = readFileSync(zshrc(), 'utf8');
  const config = readFileSync(paths().config, 'utf8');
  const second = await runSetup(scripted([true, 'off']).io, env({ ...noIngest }));
  expect(second.shellHooks).toEqual({ zsh: 'already' });
  expect(readFileSync(zshrc(), 'utf8')).toBe(before);
  expect(before.match(/# >>> leftoff >>>/g)).toHaveLength(1);
  expect(readFileSync(paths().config, 'utf8')).toBe(config);
});

test('the login shell is offered by default; declining leaves the rc file alone', async () => {
  writeFileSync(zshrc(), 'export A=1\n');
  const { io, asked } = scripted([false, 'off']);
  const result = await runSetup(io, env({ ...noIngest }));
  expect(result.shellHooks).toEqual({ zsh: 'skipped' });
  expect(readFileSync(zshrc(), 'utf8')).toBe('export A=1\n');
  expect(asked[0]).toContain('~/.zshrc');
});

test('other shells with an rc file are offered too, defaulting to no', async () => {
  writeFileSync(zshrc(), '');
  writeFileSync(join(t.home, '.bashrc'), '# mine\n');
  const { io, asked } = scripted([undefined, undefined, 'off']); // take the defaults
  const result = await runSetup(io, env({ ...noIngest }));
  expect(asked.filter((q) => q.includes('.bashrc'))).toHaveLength(1);
  expect(result.shellHooks).toEqual({ zsh: 'installed', bash: 'skipped' });
  expect(readFileSync(join(t.home, '.bashrc'), 'utf8')).toBe('# mine\n');
});

test('setup runs a catch-up ingest with a 60 s budget and prints one progress line', async () => {
  let budget = 0;
  const { io, said } = scripted([true, 'off']);
  const result = await runSetup(
    io,
    env({
      ingest: async (_ctx, opts) => {
        budget = opts?.budgetMs ?? 0;
        return report({ claude: 12, codex: 3, shell: 840, git: 25 });
      },
    }),
  );
  expect(budget).toBe(60_000);
  const progress = said.filter((l) => l.startsWith('Caught up: '));
  expect(progress).toEqual([
    'Caught up: 12 things from Claude Code, 3 from Codex, 840 terminal commands, 25 commits',
  ]);
  expect(result.progress).toBe(progress[0]);
});

test('setup survives a failing ingest and says so', async () => {
  const { io, said } = scripted([true, 'off']);
  const result = await runSetup(
    io,
    env({
      ingest: async () => {
        throw new Error('disk full');
      },
    }),
  );
  expect(result.progress).toBeNull();
  expect(said.join('\n')).toContain('could not read your history yet');
  expect(said.at(-1)).toMatch(/^To undo: run `leftoff uninstall`/);
});

function fakeClaude(list: string): void {
  const file = join(t.bin, 'claude');
  writeFileSync(
    file,
    `#!/bin/sh\necho "$*" >> "${join(t.tmp, 'claude-calls')}"\n[ "$*" = "plugin list --json" ] && printf '%s' '${list}'\nexit 0\n`,
  );
  chmodSync(file, 0o755);
}
const claudeCalls = () =>
  existsSync(join(t.tmp, 'claude-calls'))
    ? readFileSync(join(t.tmp, 'claude-calls'), 'utf8').trim().split('\n')
    : [];

test('Claude Code found: the plugin is installed from the repo when confirmed', async () => {
  fakeClaude('[]');
  const { io, asked } = scripted([true, true, false, 'off']);
  const result = await runSetup(io, env({ hasClaude: true, ...noIngest }));
  expect(asked.some((q) => q.includes('Claude Code'))).toBe(true);
  expect(result.plugin).toBe('installed');
  expect(claudeCalls()).toEqual([
    'plugin list --json', // setup: already installed?
    'plugin list --json', // installClaudePlugin checks again
    'plugin marketplace add /repo',
    'plugin install leftoff@leftoff',
  ]);
});

test('Claude Code: already installed, declined, or not found', async () => {
  fakeClaude(JSON.stringify([{ id: 'leftoff@leftoff' }]));
  expect(
    (await runSetup(scripted([true, false, 'off']).io, env({ hasClaude: true, ...noIngest })))
      .plugin,
  ).toBe('already');
  fakeClaude('[]');
  rmSync(join(t.tmp, 'claude-calls'));
  expect(
    (
      await runSetup(
        scripted([true, false, false, 'off']).io,
        env({ hasClaude: true, ...noIngest }),
      )
    ).plugin,
  ).toBe('skipped');
  expect(claudeCalls()).toEqual(['plugin list --json']);
  expect((await runSetup(scripted([true, 'off']).io, env({ ...noIngest }))).plugin).toBe(
    'not-found',
  );
  rmSync(join(t.bin, 'claude'));
  const { io, said } = scripted([true, true, false, 'off']);
  const gone = await runSetup(io, env({ hasClaude: true, ...noIngest })); // flag says yes, no binary
  expect(gone.plugin).toBe('claude-not-found');
  expect(said.join('\n')).toContain('claude plugin marketplace add /repo');
});

test('Codex logs are noted, found or not', async () => {
  const found = scripted([true, 'off']);
  await runSetup(found.io, env({ hasCodex: true, ...noIngest }));
  expect(found.said.join('\n')).toContain('Codex sessions found');
  const none = scripted([true, 'off']);
  await runSetup(none.io, env({ ...noIngest }));
  expect(none.said.join('\n')).toContain('No Codex sessions found');
});

test('polish: the options are listed with what each sends where, and the choice is saved (Task 15b)', async () => {
  const { io, said } = scripted([true, 'claude-cli']);
  const result = await runSetup(io, env({ ...noIngest }));
  expect(result.polish).toBe('claude-cli');
  const config = loadConfig();
  expect(config.polish).toMatchObject({ provider: 'claude-cli', enabled: ['claude-cli'] });
  const at = said.indexOf('AI summaries turn the brief into a short paragraph. Options:');
  expect(said.slice(at + 1, at + 7)).toEqual([
    '  off         nothing leaves your machine',
    '  claude-cli  the brief facts go to Claude Code and Anthropic, with your Claude login',
    '  codex-cli   the brief facts go to Codex and OpenAI, with your Codex login',
    '  ollama      a local model: nothing leaves your machine',
    '  anthropic   the brief facts go to the Anthropic API, with your ANTHROPIC_API_KEY',
    '  openai      the brief facts go to the OpenAI API, with your OPENAI_API_KEY',
  ]);
  // Re-running offers the current choice as the default.
  const second = scripted([true, undefined]);
  expect((await runSetup(second.io, env({ ...noIngest }))).polish).toBe('claude-cli');
});

const OLLAMA_LIST =
  'NAME          ID      SIZE    MODIFIED\nqwen3:4b      abc123  2.5 GB  2 days ago\nllama3.2:1b   def456  1.3 GB  5 days ago\n';

test('polish ollama: shows `ollama list` and lets the user pick one of their models', async () => {
  const { io, said, asked } = scripted([true, 'ollama', 'llama3.2:1b']);
  const result = await runSetup(
    io,
    env({ hasOllama: true, ollamaList: async () => OLLAMA_LIST, ...noIngest }),
  );
  expect(said.join('\n')).toContain('qwen3:4b');
  expect(said.join('\n')).toMatch(/small models are faster on 8 GB/i);
  expect(asked.at(-1)).toMatch(/model/i);
  expect(result.polish).toBe('ollama');
  expect(loadConfig().polish).toMatchObject({
    provider: 'ollama',
    enabled: ['ollama'],
    ollamaModel: 'llama3.2:1b',
  });
});

test('polish ollama without models or without ollama stays off and says how to fix it', async () => {
  const empty = scripted([true, 'ollama']);
  const r1 = await runSetup(
    empty.io,
    env({ hasOllama: true, ollamaList: async () => 'NAME ID SIZE MODIFIED\n', ...noIngest }),
  );
  expect(r1.polish).toBe('off');
  expect(empty.said.join('\n')).toContain('ollama pull');
  const missing = scripted([true, 'ollama']);
  const r2 = await runSetup(missing.io, env({ ...noIngest }));
  expect(r2.polish).toBe('off');
  expect(missing.said.join('\n')).toMatch(/ollama.*(not found|is not installed)/i);
  expect(loadConfig().polish.provider).toBe('off');
});

test('polish anthropic/openai: asks for a model and requires the key in the environment', async () => {
  const noKey = scripted([true, 'anthropic']);
  const r1 = await runSetup(noKey.io, env({ ...noIngest }));
  expect(r1.polish).toBe('off');
  expect(noKey.said.join('\n')).toContain('ANTHROPIC_API_KEY');
  process.env.OPENAI_API_KEY = 'sk-test-not-real';
  const withKey = scripted([true, 'openai', 'some-model']);
  const r2 = await runSetup(withKey.io, env({ ...noIngest }));
  expect(r2.polish).toBe('openai');
  expect(loadConfig().polish).toMatchObject({
    provider: 'openai',
    enabled: ['openai'],
    apiModel: 'some-model',
  });
  expect(withKey.said.join('\n')).not.toContain('sk-test-not-real'); // never echoed
});

test('setup never touches anything outside the given home and LEFTOFF_HOME', async () => {
  mkdirSync(join(t.home, '.config', 'fish'), { recursive: true });
  const before = existsSync(join(process.env.CLAUDE_CONFIG_DIR as string));
  await runSetup(scripted([true, 'off']).io, env({ ...noIngest }));
  expect(existsSync(join(process.env.CLAUDE_CONFIG_DIR as string))).toBe(before);
  expect(existsSync(join(t.home, '.config', 'fish', 'config.fish'))).toBe(false);
});

// ---- Task 15b E/F ----

test('Claude Code installed: claude-cli is recommended with Yes as the default, but still asked', async () => {
  fakeClaude(JSON.stringify([{ id: 'leftoff@leftoff' }]));
  const yes = scripted([true, undefined]); // zsh hook, then Enter on the recommendation
  expect((await runSetup(yes.io, env({ hasClaude: true, ...noIngest }))).polish).toBe('claude-cli');
  expect(yes.asked.at(-1)).toMatch(/^Use Claude Code for AI summaries \(recommended\)\?/);
  const no = scripted([true, false, 'ollama']);
  await runSetup(no.io, env({ hasClaude: true, ...noIngest }));
  expect(no.asked.at(-1)).toBe('Which one?'); // declined: the full list
});

test('the catch-up line leaves out sources with nothing new', async () => {
  const { io, said } = scripted([true, 'off']);
  await runSetup(io, env({ ingest: async () => report({ claude: 119, shell: 2 }) }));
  expect(said).toContain('Caught up: 119 things from Claude Code, 2 terminal commands');
  const none = scripted([true, 'off']);
  await runSetup(none.io, env({ ...noIngest }));
  expect(none.said).toContain('Caught up: nothing to read yet');
});

test('setup ends with what it installed, what to try next and how to undo it', async () => {
  fakeClaude(JSON.stringify([{ id: 'leftoff@leftoff' }]));
  const { io, said } = scripted([true, undefined]);
  await runSetup(io, env({ hasClaude: true, ...noIngest }));
  const at = said.indexOf('Setup finished. Installed:');
  expect(said.slice(at)).toEqual([
    'Setup finished. Installed:',
    '  • the shell hook in ~/.zshrc',
    '  • the leftoff plugin in Claude Code',
    '  • AI summaries with claude-cli',
    `  • your data folder, ${paths().home}`,
    'Try next:',
    '  • open a new terminal in a project: a short brief appears when you have been away',
    '  • leftoff resume: where you left off in this project',
    '  • leftoff: loose ends across all your projects',
    'To undo: run `leftoff uninstall` (it removes the hooks and asks before deleting any data)',
  ]);
});
