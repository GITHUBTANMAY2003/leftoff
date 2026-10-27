import { execFile } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { promisify } from 'node:util';
import pkg from '../../../package.json' with { type: 'json' };
import { claudeDir } from '../../collectors/claude.ts';
import { codexDir } from '../../collectors/codex.ts';
import {
  loadConfig,
  POLISH_PROVIDERS,
  saveConfig,
  type PolishProviderName,
  type PolishSetting,
} from '../../core/config.ts';
import { logError } from '../../core/logger.ts';
import { ensureHome, paths } from '../../core/paths.ts';
import { ingest as realIngest, type IngestReport } from '../../ingest/ingest.ts';
import {
  claudePluginInstalled,
  installClaudePlugin,
  manualPluginCommands,
} from '../../install/claude-plugin.ts';
import {
  hasShellHook,
  installShellHook,
  installShellScripts,
  rcPathFor,
  type ShellName,
} from '../../install/shell-rc.ts';
import { installShim, stableNodePath } from '../../install/shim.ts';
import { onPath } from '../../polish/providers/run-cli.ts';
import { plural } from '../../render/text.ts';
import { openDb } from '../../store/db.ts';
import { createRepo } from '../../store/repo.ts';
import type { Prompter } from '../prompter.ts';

// `leftoff setup` (§1.10): idempotent; the shim and shell scripts are rewritten
// on every run so they always point at the current install (R-C4, R-B8).

export interface SetupEnv {
  home: string; // where the rc files live
  shell: string; // $SHELL
  hasClaude: boolean;
  hasCodex: boolean;
  hasOllama: boolean;
  // Test seams; the defaults describe the running install.
  cliPath?: string;
  shellDir?: string; // the package's shell/ folder
  pluginSource?: string; // marketplace source: the repo folder, or its GitHub name
  ollamaList?: () => Promise<string>;
  ingest?: typeof realIngest;
}

export interface SetupResult {
  shellHooks: Partial<Record<ShellName, 'installed' | 'already' | 'skipped'>>;
  plugin: 'installed' | 'already' | 'failed' | 'claude-not-found' | 'skipped' | 'not-found';
  polish: PolishSetting;
  progress: string | null;
}

const SHELLS: ShellName[] = ['zsh', 'bash', 'fish'];
const CATCH_UP_BUDGET_MS = 60_000;
const POLISH_CHOICES = ['off', ...POLISH_PROVIDERS] as const;
const API_KEYS: Partial<Record<PolishProviderName, string>> = {
  anthropic: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
};
const PRIVACY =
  'off: nothing leaves your machine · claude-cli, codex-cli: the brief facts go to that tool and its service · ' +
  'ollama: stays on this machine · anthropic, openai: sent to their API with your key';

export function detectSetupEnv(): SetupEnv {
  return {
    home: homedir(),
    shell: process.env.SHELL ?? '',
    hasClaude: onPath('claude') || existsSync(claudeDir()),
    hasCodex: existsSync(codexDir()),
    hasOllama: onPath('ollama'),
  };
}

// The package's shell/ folder, next to dist/ (or src/cli/ when run from source).
function packageShellDir(cliPath: string): string {
  for (const rel of ['../shell', '../../shell']) {
    const dir = resolve(dirname(cliPath), rel);
    if (existsSync(join(dir, 'leftoff.zsh'))) return dir;
  }
  throw new Error(`cannot find the shell scripts next to ${cliPath}`);
}

async function ollamaList(): Promise<string> {
  const { stdout } = await promisify(execFile)('ollama', ['list'], { timeout: 5000 });
  return stdout;
}

const modelNames = (list: string) =>
  list
    .split('\n')
    .slice(1) // the header
    .map((line) => line.trim().split(/\s+/)[0] ?? '')
    .filter(Boolean);

type Config = ReturnType<typeof loadConfig>;

// Asks for the polish provider; a choice whose prerequisites are missing falls
// back to off, with what to do about it.
async function choosePolish(io: Prompter, env: SetupEnv, config: Config): Promise<PolishSetting> {
  const current = config.polish.provider;
  const def = POLISH_CHOICES.find((c) => c === current) ?? config.polish.enabled[0] ?? 'off';
  io.say(PRIVACY);
  const choice = await io.choose('AI summaries (polish)?', [...POLISH_CHOICES], def);
  const off = (reason?: string): PolishSetting => {
    if (reason) io.say(reason);
    config.polish.provider = 'off';
    config.polish.enabled = [];
    return 'off';
  };
  if (choice === 'off') return off();
  if (choice === 'ollama') {
    if (!env.hasOllama) {
      return off(
        'ollama was not found on this machine. Install it from ollama.com, then run leftoff setup again.',
      );
    }
    let names: string[] = [];
    try {
      const list = await (env.ollamaList ?? ollamaList)();
      io.say('Your ollama models:');
      for (const line of list.trimEnd().split('\n')) io.say(`  ${line}`);
      names = modelNames(list);
    } catch (err) {
      logError('setup', err);
    }
    if (names.length === 0) {
      return off(
        'No ollama models are installed. Run `ollama pull <model>`, then run leftoff setup again.',
      );
    }
    io.say('Small models are faster on 8 GB machines.');
    const keep = config.polish.ollamaModel;
    config.polish.ollamaModel = await io.choose(
      'Which model should leftoff use?',
      names,
      keep !== null && names.includes(keep) ? keep : (names[0] as string),
    );
  } else if (choice === 'anthropic' || choice === 'openai') {
    const key = API_KEYS[choice] as string;
    if (!process.env[key]) {
      return off(`Set ${key} in your environment, then run leftoff setup again.`);
    }
    const model = await io.input(`Model name for ${choice}?`, config.polish.apiModel ?? '');
    if (model === '') return off('A model name is required, so polish stays off.');
    config.polish.apiModel = model;
  }
  config.polish.provider = choice;
  config.polish.enabled = [choice];
  return choice;
}

export async function runSetup(io: Prompter, env: SetupEnv): Promise<SetupResult> {
  // 1. home, then the shim and the shell scripts (both on every run)
  ensureHome();
  const cliPath = env.cliPath ?? realpathSync(process.argv[1] ?? '');
  const shellDir = env.shellDir ?? packageShellDir(cliPath);
  installShim(stableNodePath(), cliPath);
  installShellScripts(shellDir, pkg.version);

  // 2. shell hooks: the login shell by default, other shells that have an rc file on request
  const login = basename(env.shell);
  const shellHooks: SetupResult['shellHooks'] = {};
  const candidates = SHELLS.filter((s) => s === login || existsSync(rcPathFor(s, env.home))).sort(
    (a, b) => Number(b === login) - Number(a === login),
  );
  for (const shell of candidates) {
    const rc = rcPathFor(shell, env.home);
    const shown = `~/${relative(env.home, rc)}`;
    const script = join(paths().shellDir, `leftoff.${shell}`);
    const want = await io.confirm(
      `Add the leftoff hook to ${shown}? (records commands, prints a short brief when you open a project)`,
      shell === login || hasShellHook(rc),
    );
    shellHooks[shell] = want ? installShellHook(shell, rc, script) : 'skipped';
  }

  // 3. the Claude Code plugin
  let plugin: SetupResult['plugin'] = 'not-found';
  if (env.hasClaude) {
    const source = env.pluginSource ?? dirname(shellDir);
    if (await claudePluginInstalled()) {
      plugin = 'already';
      io.say('The leftoff plugin is already installed in Claude Code.');
    } else if (await io.confirm('Install the leftoff plugin in Claude Code?', true)) {
      plugin = await installClaudePlugin(source, io.say);
      if (plugin === 'claude-not-found') {
        io.say('The claude command was not found. To add the plugin later, run:');
        for (const command of manualPluginCommands(source)) io.say(`  ${command}`);
      }
    } else {
      plugin = 'skipped';
    }
  }

  // 4. Codex
  io.say(env.hasCodex ? 'Codex sessions found.' : 'No Codex sessions found.');

  // 5. polish, then save the config (every run, so the file always exists)
  const config = loadConfig();
  const polish = await choosePolish(io, env, config);
  saveConfig(config);

  // 6. first catch-up ingest
  let progress: string | null = null;
  const db = openDb();
  try {
    const report: IngestReport = await (env.ingest ?? realIngest)(
      { repo: createRepo(db), config, now: new Date() },
      { budgetMs: CATCH_UP_BUDGET_MS },
    );
    const n = (name: keyof IngestReport['perSource']) => report.perSource[name].inserted;
    progress = `Read ${plural(n('claude'), 'Claude event')}, ${plural(n('codex'), 'Codex event')}, ${plural(n('shell'), 'command')}, ${plural(n('git'), 'commit')}`;
    io.say(progress);
  } catch (err) {
    logError('setup', err);
    io.say('leftoff could not read your history yet; it will catch up the next time you use it.');
  } finally {
    db.close();
  }

  // 7. summary
  io.say('Open a new terminal to start.');
  return { shellHooks, plugin, polish, progress };
}
