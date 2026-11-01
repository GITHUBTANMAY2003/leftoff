import { afterEach, expect, test } from 'vitest';
import { budget } from './helpers.ts';

// Performance budgets are strict only with PERF_STRICT=1 (locally, dogfood
// checklist). Shared CI runners are slower: there each budget is 3×.

const saved = process.env.PERF_STRICT;
afterEach(() => {
  if (saved === undefined) delete process.env.PERF_STRICT;
  else process.env.PERF_STRICT = saved;
});

test('PERF_STRICT=1 keeps the budget as written', () => {
  process.env.PERF_STRICT = '1';
  expect(budget(1500)).toBe(1500);
});

test('without PERF_STRICT the budget is 3×', () => {
  delete process.env.PERF_STRICT;
  expect(budget(1500)).toBe(4500);
  process.env.PERF_STRICT = '0';
  expect(budget(300)).toBe(900);
});
