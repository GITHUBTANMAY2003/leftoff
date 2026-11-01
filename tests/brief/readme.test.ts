import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { readmeLine, readmeOneLiner } from '../../src/brief/readme.ts';

// What the project is, from its README (owner decision after Task 15c): the
// first heading, or — when the heading is just the project's name — the first
// sentence of the first paragraph.

test.each([
  [
    'heading is the name: the first sentence, without "<name> is"',
    'quillmark',
    '# Quillmark\n\nQuillmark is a small local notes app for people who write in Markdown.\nIt syncs nothing.',
    'a small local notes app for people who write in Markdown',
  ],
  [
    'heading is the name in another case',
    'Ferrule',
    '# ferrule\n\nA strict config linter, written in Rust. It reads TOML only.',
    'A strict config linter, written in Rust',
  ],
  [
    'badges, images and html are skipped; emphasis is dropped',
    'tidepool',
    '# tidepool\n\n[![CI](https://x/badge.svg)](https://x)\n<p align="center"><img src="logo.png"></p>\n\n**Serverless key-value cache on your own cloud account.**\n`tidepool` uses a table.',
    'Serverless key-value cache on your own cloud account',
  ],
  [
    'a descriptive heading is used as it is',
    'hack-week-7',
    '# Ghost Orders: a refund-audit agent\n\nFor every order, the agent checks three things.',
    'Ghost Orders: a refund-audit agent',
  ],
  [
    'setext heading',
    'basin',
    'Basin\n=====\n\nBasin is a tiny job queue for SQLite.\n',
    'a tiny job queue for SQLite',
  ],
])('%s', (_name, project, text, expected) => {
  expect(readmeLine(text, project)).toBe(expected);
});

test('a long line is cut at a word, about 80 characters', () => {
  const line = readmeLine(
    `# x\n\nX is ${'a very long description '.repeat(10)}here.`,
    'x',
  ) as string;
  expect([...line].length).toBeLessThanOrEqual(80);
  expect(line.endsWith('…')).toBe(true);
  expect(line).not.toMatch(/ \S{1,3}…$/);
});

test('nothing usable: null', () => {
  expect(readmeLine('# x\n\n![logo](logo.png)\n\n```bash\nnpm i x\n```\n', 'x')).toBeNull();
  expect(readmeLine('', 'x')).toBeNull();
});

test('readmeOneLiner reads README.md (any case), or returns null without one', () => {
  const dir = mkdtempSync(join(tmpdir(), 'leftoff-readme-'));
  try {
    mkdirSync(join(dir, 'app'));
    expect(readmeOneLiner(join(dir, 'app'))).toBeNull();
    writeFileSync(join(dir, 'app', 'readme.md'), '# app\n\nApp is a shop for used bikes.\n');
    expect(readmeOneLiner(join(dir, 'app'))).toBe('a shop for used bikes');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
