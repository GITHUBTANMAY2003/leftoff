import { spawnSync } from 'node:child_process';
import {
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
import { join } from 'node:path';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { paths } from '../../src/core/paths.ts';
import { installShim, shimStatus, stableNodePath } from '../../src/install/shim.ts';

let tmp: string;
const saved = process.env.LEFTOFF_HOME;

beforeEach(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), "leftoff shim's-")));
  process.env.LEFTOFF_HOME = join(tmp, 'lhome');
});

afterEach(() => {
  if (saved === undefined) delete process.env.LEFTOFF_HOME;
  else process.env.LEFTOFF_HOME = saved;
  rmSync(tmp, { recursive: true, force: true });
});

// A stand-in for dist/cli.js: prints its arguments.
function fakeCli(name: string, text: string): string {
  const file = join(tmp, name);
  writeFileSync(file, `console.log(${JSON.stringify(text)}, process.argv.slice(2).join(' '));\n`);
  return file;
}

test('installShim writes an executable script with absolute node and cli paths; re-run overwrites', () => {
  // The temp path has a space and a quote, so quoting matters.
  const first = fakeCli('cli-1.mjs', 'one');
  installShim(process.execPath, first);
  const shim = paths().shim;
  expect(statSync(shim).mode & 0o777).toBe(0o700);
  expect(readFileSync(shim, 'utf8').startsWith('#!/bin/sh\n')).toBe(true);
  expect(spawnSync(shim, ['a b', 'c'], { encoding: 'utf8' }).stdout).toBe('one a b c\n');
  const second = fakeCli('cli-2.mjs', 'two');
  installShim(process.execPath, second);
  expect(spawnSync(shim, ['x'], { encoding: 'utf8' }).stdout).toBe('two x\n');
  expect(shimStatus()).toEqual({
    exists: true,
    nodePath: process.execPath,
    cliPath: second,
    works: true,
  });
});

test('shimStatus reports works=false when the cli path no longer exists', () => {
  const cli = fakeCli('cli.mjs', 'v');
  installShim(process.execPath, cli);
  rmSync(cli);
  expect(shimStatus()).toMatchObject({ exists: true, cliPath: cli, works: false });
});

test('shimStatus reports works=false when the cli fails, and exists=false without a shim', () => {
  expect(shimStatus()).toEqual({ exists: false, nodePath: null, cliPath: null, works: false });
  const cli = join(tmp, 'broken.mjs');
  writeFileSync(cli, 'process.exit(3);\n');
  installShim(process.execPath, cli);
  expect(shimStatus().works).toBe(false);
});

// A bin directory holding `node` as a symlink to target.
function binWithNode(name: string, target: string): string {
  const dir = join(tmp, name);
  mkdirSync(dir, { recursive: true });
  symlinkSync(target, join(dir, 'node'));
  return dir;
}

test('stableNodePath prefers an unversioned node on PATH that is the same binary', () => {
  const stable = binWithNode('brew-bin', process.execPath);
  expect(stableNodePath(process.execPath, `/nonexistent:${stable}:/usr/bin`)).toBe(
    join(stable, 'node'),
  );
});

test('stableNodePath falls back to execPath when PATH has no node or a different one', () => {
  expect(stableNodePath(process.execPath, '/nonexistent')).toBe(process.execPath);
  const other = join(tmp, 'other-node');
  writeFileSync(other, '#!/bin/sh\n');
  expect(stableNodePath(process.execPath, binWithNode('other-bin', other))).toBe(process.execPath);
});

test('stableNodePath skips fnm per-shell links, which disappear when that shell exits', () => {
  const fnm = binWithNode('fnm_multishells/1234_5678/bin', process.execPath);
  expect(stableNodePath(process.execPath, fnm)).toBe(process.execPath);
});

test('the shim exits 0 silently when its node or cli is gone (hooks never error)', () => {
  const cli = fakeCli('cli.mjs', 'v');
  const node = join(binWithNode('gone-bin', process.execPath), 'node');
  installShim(node, cli);
  expect(spawnSync(paths().shim, ['x'], { encoding: 'utf8' }).stdout).toBe('v x\n');
  expect(shimStatus()).toMatchObject({ nodePath: node, cliPath: cli, works: true });
  rmSync(node);
  const noNode = spawnSync(paths().shim, ['x'], { encoding: 'utf8' });
  expect([noNode.status, noNode.stdout, noNode.stderr]).toEqual([0, '', '']);
  expect(shimStatus().works).toBe(false); // doctor: "shim broken, run leftoff setup"
  installShim(process.execPath, join(tmp, 'missing-cli.mjs'));
  const noCli = spawnSync(paths().shim, ['x'], { encoding: 'utf8' });
  expect([noCli.status, noCli.stdout, noCli.stderr]).toEqual([0, '', '']);
});
