import { expect, test } from 'vitest';
import { clipMiddle } from '../../src/render/text.ts';

test('clipMiddle keeps program + subcommand and the end of a long command', () => {
  const cmd =
    'cargo test -p looplint_adapters --test openai_agents -- qualified_and_aliased star_import';
  const out = clipMiddle(cmd, 50);
  expect([...out].length).toBeLessThanOrEqual(50);
  expect(out.startsWith('cargo test … ')).toBe(true);
  expect(out.endsWith('star_import')).toBe(true);
});

test('clipMiddle leaves short text alone and falls back to a plain cut when too narrow', () => {
  expect(clipMiddle('make deploy', 50)).toBe('make deploy');
  const narrow = clipMiddle('cargo test -p looplint_adapters --test openai_agents', 12);
  expect([...narrow].length).toBeLessThanOrEqual(12);
  expect(narrow.endsWith('…')).toBe(true);
});

test('clipMiddle never starts the tail in the middle of a word', () => {
  const text = 'cargo test -p looplint_adapters --test openai_agents -- alpha beta gamma delta';
  const words = text.split(' ');
  for (const max of [40, 45, 52, 60]) {
    const out = clipMiddle(text, max);
    expect([...out].length).toBeLessThanOrEqual(max);
    const tail = out.split(' … ')[1] as string;
    expect(
      tail.split(' ').every((w) => words.includes(w)),
      `${max}: ${out}`,
    ).toBe(true);
  }
});

test('clipMiddle falls back to a plain cut when less than 8 characters would be left for the end', () => {
  const out = clipMiddle('cargo test -p looplint_adapters --test openai_agents', 20); // head 10 → room 7
  expect(out).not.toContain(' … ');
  expect(out).toBe('cargo test -p…'); // clip() cuts at a word
});
