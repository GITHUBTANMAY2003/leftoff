import { afterEach, expect, test, vi } from 'vitest';
import { withBudget } from '../../src/core/budget.ts';

afterEach(() => {
  vi.useRealTimers();
});

test('withBudget returns undefined after timeout', async () => {
  expect(await withBudget(new Promise((r) => setTimeout(() => r(1), 50)), 10)).toBeUndefined();
});

test('withBudget returns the value when the promise settles in time', async () => {
  expect(await withBudget(Promise.resolve(42), 100)).toBe(42);
});

test('withBudget passes a rejection through instead of reporting a timeout', async () => {
  await expect(withBudget(Promise.reject(new Error('collector failed')), 100)).rejects.toThrow(
    'collector failed',
  );
});

test('withBudget clears its timer once the promise settles', async () => {
  vi.useFakeTimers();
  await withBudget(Promise.resolve(1), 10_000);
  expect(vi.getTimerCount()).toBe(0);
});

test('a rejection after the budget expired is swallowed, not unhandled', async () => {
  const unhandled: unknown[] = [];
  const onUnhandled = (e: unknown) => unhandled.push(e);
  process.on('unhandledRejection', onUnhandled);
  try {
    const late = new Promise((_, reject) => setTimeout(() => reject(new Error('late')), 20));
    expect(await withBudget(late, 5)).toBeUndefined();
    await new Promise((r) => setTimeout(r, 40));
    expect(unhandled).toEqual([]);
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
});
