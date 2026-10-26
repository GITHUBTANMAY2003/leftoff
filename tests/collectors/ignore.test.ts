import { homedir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { compileIgnore } from '../../src/collectors/ignore.ts';
import { DEFAULT_CONFIG, type Config } from '../../src/core/config.ts';

function ignore(projects: string[], commands: string[] = []) {
  const config = structuredClone(DEFAULT_CONFIG) as Config;
  config.ignore = { projects, commands };
  return compileIgnore(config);
}

test('a project folder and everything under it is ignored', () => {
  const i = ignore(['/work/secret']);
  expect(i.isIgnoredProject('/work/secret')).toBe(true);
  expect(i.isIgnoredProject('/work/secret/app/src')).toBe(true);
  expect(i.isIgnoredProject('/work/secret-other')).toBe(false);
  expect(i.isIgnoredProject('/work')).toBe(false);
});

test('* stays within one folder name; ** crosses folders', () => {
  const i = ignore(['/clients/*/private', '/archive/**/old']);
  expect(i.isIgnoredProject('/clients/acme/private')).toBe(true);
  expect(i.isIgnoredProject('/clients/acme/x/private')).toBe(false);
  expect(i.isIgnoredProject('/archive/a/b/old')).toBe(true);
});

test('a leading ~ means the home folder', () => {
  expect(ignore(['~/secret']).isIgnoredProject(join(homedir(), 'secret', 'app'))).toBe(true);
});

test('command globs match the normalized command; * matches anything', () => {
  const i = ignore([], ['vault *', 'pass']);
  expect(i.isIgnoredCommand('FOO=1  vault   read secret/db')).toBe(true);
  expect(i.isIgnoredCommand('pass')).toBe(true);
  expect(i.isIgnoredCommand('passwd-check')).toBe(false);
});

test('no globs: nothing is ignored', () => {
  const i = ignore([]);
  expect(i.isIgnoredProject('/anything')).toBe(false);
  expect(i.isIgnoredCommand('anything')).toBe(false);
});
