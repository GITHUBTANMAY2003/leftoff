import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { runUninstall } from '../../src/cli/commands/uninstall.ts';
import { ensureHome, paths } from '../../src/core/paths.ts';
import { installShellHook, rcPathFor } from '../../src/install/shell-rc.ts';
import { scripted } from '../helpers/prompter.ts';
import { useTempHome } from '../helpers/home.ts';

const t = useTempHome();

function installed(): void {
  ensureHome();
  writeFileSync(join(paths().shellDir, 'leftoff.zsh'), '# leftoff x\n');
  writeFileSync(paths().shim, '#!/bin/sh\n');
  for (const [shell, before] of [
    ['zsh', 'export A=1\n'],
    ['bash', '# bash\n'],
    ['fish', ''],
  ] as const) {
    const rc = rcPathFor(shell, t.home);
    mkdirSync(join(rc, '..'), { recursive: true });
    writeFileSync(rc, before);
    installShellHook(shell, rc, join(paths().shellDir, `leftoff.${shell}`));
  }
}
// Claude Code's folder name for /x/a1.b2/tmp is -x-a1-b2-tmp: letters and digits stay.
const memoryFolder = () =>
  join(process.env.CLAUDE_CONFIG_DIR as string, 'projects', paths().tmp.replace(/[^\w]|_/g, '-'));

test('uninstall removes the rc blocks and keeps data unless confirmed', async () => {
  installed();
  const { io, asked } = scripted([false]);
  const out = await runUninstall(io, { home: t.home });
  expect(readFileSync(rcPathFor('zsh', t.home), 'utf8')).toBe('export A=1\n');
  expect(readFileSync(rcPathFor('bash', t.home), 'utf8')).toBe('# bash\n');
  expect(readFileSync(rcPathFor('fish', t.home), 'utf8')).toBe('');
  expect(out).toContain('Removed the leftoff block from ~/.zshrc');
  expect(asked).toHaveLength(1); // only "delete your data?"
  expect(existsSync(paths().home)).toBe(true);
  expect(out).toContain(`Your data is still in ${paths().home}`);
});

test('confirming deletes the data folder, including the shim', async () => {
  installed();
  const out = await runUninstall(scripted([true]).io, { home: t.home });
  expect(existsSync(paths().home)).toBe(false);
  expect(out).toContain(`Deleted ${paths().home}`);
});

test('uninstall prints the plugin uninstall commands and does nothing else about the plugin', async () => {
  const out = await runUninstall(scripted([false]).io, { home: t.home });
  expect(out).toContain('claude plugin uninstall leftoff@leftoff');
  expect(out).toContain('claude plugin marketplace remove leftoff');
});

test('uninstall prints the leftover claude -p folder and its removal command, and never deletes it', async () => {
  process.env.LEFTOFF_HOME = join(t.tmp, 'h0me.x9'); // digits and a dot in the path
  installed();
  const folder = memoryFolder();
  mkdirSync(join(folder, 'memory'), { recursive: true });
  const out = await runUninstall(scripted([true]).io, { home: t.home });
  expect(out).toContain(folder);
  expect(out).toContain(`rm -r '${folder}'`);
  expect(existsSync(join(folder, 'memory'))).toBe(true);
});

test('without that folder nothing is said about it; a rerun finds no blocks and says so', async () => {
  installed();
  const first = await runUninstall(scripted([false]).io, { home: t.home });
  expect(first).not.toContain('claude -p');
  const second = await runUninstall(scripted([false]).io, { home: t.home });
  expect(second).toContain('No leftoff block found in your shell files');
});

test('uninstall never touches a shell rc file outside the given home', async () => {
  installed();
  const other = join(t.tmp, 'other', '.zshrc');
  mkdirSync(join(other, '..'));
  installShellHook('zsh', other, '/x/leftoff.zsh');
  await runUninstall(scripted([false]).io, { home: t.home });
  expect(readFileSync(other, 'utf8')).toContain('# >>> leftoff >>>');
});

test('the default answer to "delete your data?" is no', async () => {
  installed();
  await runUninstall(scripted([undefined]).io, { home: t.home });
  expect(existsSync(paths().home)).toBe(true);
});
