import { spawnSync } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { paths } from '../../src/core/paths.ts';
import {
  installedShellScriptVersion,
  installShellHook,
  installShellScripts,
  removeShellHook,
} from '../../src/install/shell-rc.ts';
import { hasShell, runInteractive } from '../shell/run-shell.ts';

const PACKAGE_SHELL_DIR = resolve(import.meta.dirname, '../../shell');
let tmp: string;
let rc: string;
const savedHome = process.env.LEFTOFF_HOME;

beforeEach(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), 'leftoff-rc-')));
  process.env.LEFTOFF_HOME = join(tmp, 'lhome');
  rc = join(tmp, '.zshrc');
});

afterEach(() => {
  if (savedHome === undefined) delete process.env.LEFTOFF_HOME;
  else process.env.LEFTOFF_HOME = savedHome;
  rmSync(tmp, { recursive: true, force: true });
});

test('installShellHook is idempotent and removable', () => {
  const script = join(tmp, 'lhome', 'shell', 'leftoff.zsh');
  expect(installShellHook('zsh', rc, script)).toBe('installed');
  expect(installShellHook('zsh', rc, script)).toBe('already');
  expect(readFileSync(rc, 'utf8')).toContain('# >>> leftoff >>>');
  expect(removeShellHook(rc)).toBe(true);
  expect(readFileSync(rc, 'utf8')).not.toContain('leftoff');
});

test('install then remove restores the original rc file byte for byte', () => {
  const original = 'export PATH="$HOME/bin:$PATH"\nalias ll="ls -l"\n';
  writeFileSync(rc, original);
  installShellHook('zsh', rc, '/x/leftoff.zsh');
  expect(removeShellHook(rc)).toBe(true);
  expect(readFileSync(rc, 'utf8')).toBe(original);
});

test('the block is appended after existing content, which is left untouched', () => {
  writeFileSync(rc, 'alias ll="ls -l"'); // no trailing newline
  installShellHook('zsh', rc, '/x/leftoff.zsh');
  const text = readFileSync(rc, 'utf8');
  expect(text.startsWith('alias ll="ls -l"\n')).toBe(true);
  expect(text.endsWith('# <<< leftoff <<<\n')).toBe(true);
});

test('removeShellHook returns false when there is no block or no file', () => {
  expect(removeShellHook(rc)).toBe(false);
  writeFileSync(rc, 'alias ll="ls -l"\n');
  expect(removeShellHook(rc)).toBe(false);
  expect(readFileSync(rc, 'utf8')).toBe('alias ll="ls -l"\n');
});

test('a missing rc file (and fish config dir) is created', () => {
  const fishRc = join(tmp, '.config', 'fish', 'config.fish');
  expect(installShellHook('fish', fishRc, '/x/leftoff.fish')).toBe('installed');
  expect(readFileSync(fishRc, 'utf8')).toContain('# >>> leftoff >>>');
});

test('zsh/bash block sources the script behind a [ -r ] guard; fish uses test -r', () => {
  installShellHook('bash', rc, '/x/leftoff.bash');
  expect(readFileSync(rc, 'utf8')).toContain('[ -r "/x/leftoff.bash" ] && . "/x/leftoff.bash"');
  const fishRc = join(tmp, 'config.fish');
  installShellHook('fish', fishRc, '/x/leftoff.fish');
  expect(readFileSync(fishRc, 'utf8')).toContain(
    'test -r "/x/leftoff.fish"; and source "/x/leftoff.fish"',
  );
});

test('a changed script path replaces the block instead of adding a second one', () => {
  installShellHook('zsh', rc, '/old/leftoff.zsh');
  expect(installShellHook('zsh', rc, '/new/leftoff.zsh')).toBe('installed');
  const text = readFileSync(rc, 'utf8');
  expect(text.match(/# >>> leftoff >>>/g)).toHaveLength(1);
  expect(text).toContain('/new/leftoff.zsh');
  expect(text).not.toContain('/old/leftoff.zsh');
});

test('an rc file that is a symlink (dotfiles repo) stays a symlink', () => {
  const real = join(tmp, 'dotfiles-zshrc');
  writeFileSync(real, 'alias ll="ls -l"\n');
  symlinkSync(real, rc);
  installShellHook('zsh', rc, '/x/leftoff.zsh');
  expect(lstatSync(rc).isSymbolicLink()).toBe(true);
  expect(readFileSync(real, 'utf8')).toContain('# >>> leftoff >>>');
});

test.skipIf(!hasShell('zsh'))(
  'sourcing the rc block when the script is missing prints nothing and succeeds (zsh, path with spaces)',
  () => {
    const script = join(tmp, 'dir with spaces', 'leftoff.zsh'); // never created
    installShellHook('zsh', rc, script);
    const r = spawnSync('zsh', ['-f', '-c', `source ${JSON.stringify(rc)}; echo done`], {
      encoding: 'utf8',
    });
    expect(r.stdout).toBe('done\n');
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
  },
);

test('installShellScripts copies the scripts with a version header and mode 0600', () => {
  installShellScripts(PACKAGE_SHELL_DIR, '1.2.3');
  for (const shell of ['zsh', 'bash', 'fish'] as const) {
    const copy = join(paths().shellDir, `leftoff.${shell}`);
    expect(statSync(copy).mode & 0o777).toBe(0o600);
    const text = readFileSync(copy, 'utf8');
    expect(text.split('\n')[0]).toBe('# leftoff 1.2.3');
    expect(text).toContain(readFileSync(join(PACKAGE_SHELL_DIR, `leftoff.${shell}`), 'utf8'));
    expect(installedShellScriptVersion(shell)).toBe('1.2.3');
  }
});

test('installShellScripts overwrites older copies; version is null when not installed', () => {
  expect(installedShellScriptVersion('zsh')).toBeNull();
  installShellScripts(PACKAGE_SHELL_DIR, '1.0.0');
  installShellScripts(PACKAGE_SHELL_DIR, '1.1.0');
  expect(installedShellScriptVersion('zsh')).toBe('1.1.0');
});

test.skipIf(!hasShell('zsh'))(
  'end to end: setup-style install into a temp ZDOTDIR records a command from a real zsh',
  () => {
    installShellScripts(PACKAGE_SHELL_DIR, '0.0.1');
    installShellHook('zsh', join(tmp, '.zshrc'), join(paths().shellDir, 'leftoff.zsh'));
    mkdirSync(join(tmp, 'work'));
    // -d: skip /etc/zshrc; ZDOTDIR makes zsh read our temp .zshrc.
    runInteractive(
      'zsh',
      ['PS1=', `cd ${join(tmp, 'work')}`, 'echo e2e', 'exit'],
      { HOME: tmp, ZDOTDIR: tmp, LEFTOFF_HOME: join(tmp, 'lhome') },
      ['-d', '-i'],
    );
    const log = paths().shellLog;
    expect(existsSync(log)).toBe(true);
    expect(readFileSync(log, 'utf8')).toMatch(/\t0\t\d+\t\d+\t.*\techo e2e\n$/);
  },
);
