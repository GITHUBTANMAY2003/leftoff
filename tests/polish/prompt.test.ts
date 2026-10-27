import { expect, test } from 'vitest';
import type { BriefFacts } from '../../src/brief/facts.ts';
import { buildPolishPrompt, MAX_FACTS_CHARS, validatePolish } from '../../src/polish/prompt.ts';
import { rahulFacts } from '../render/helpers.ts';

const factsJsonOf = (prompt: string) => prompt.slice(prompt.indexOf('{'));

test('prompt contains facts JSON and the no-invention instruction, ≤ 8000 chars', () => {
  const f = rahulFacts();
  const prompt = buildPolishPrompt(f);
  expect(prompt).toMatch(/at most 4 sentences/);
  expect(prompt).toMatch(/add nothing that is not in the facts/i);
  const json = factsJsonOf(prompt);
  expect(json.length).toBeLessThanOrEqual(MAX_FACTS_CHARS);
  expect(JSON.parse(json)).toMatchObject({
    project: f.project,
    nextStep: f.nextStep,
    openProblems: f.openProblems,
  });
});

test('large facts are shrunk to ≤ 8000 chars and stay valid JSON, keeping the next step', () => {
  const long = 'x'.repeat(500);
  const f: BriefFacts = {
    ...rahulFacts(),
    done: Array.from({ length: 60 }, (_, i) => `commit ${i} ${long}`),
    notes: Array.from({ length: 60 }, (_, i) => `note ${i} ${long}`),
    unfinished: {
      files: Array.from({ length: 200 }, (_, i) => ({ path: `src/f${i}.ts`, status: 'modified' })),
      diffStat: null,
    },
    lastIntent: long,
  };
  expect(MAX_FACTS_CHARS).toBe(8000);
  const json = factsJsonOf(buildPolishPrompt(f));
  expect(json.length).toBeLessThanOrEqual(MAX_FACTS_CHARS);
  const parsed = JSON.parse(json) as BriefFacts;
  expect(parsed.nextStep).toBe(f.nextStep);
  expect(parsed.done[0]).toMatch(/^commit 0 /);
});

test('validatePolish trims; empty or over 1200 characters is rejected', () => {
  expect(validatePolish('  You were fixing SMTP.  \n')).toBe('You were fixing SMTP.');
  expect(validatePolish('   \n ')).toBeNull();
  expect(validatePolish('a'.repeat(1200))).toBe('a'.repeat(1200));
  expect(validatePolish('a'.repeat(1201))).toBeNull();
});
