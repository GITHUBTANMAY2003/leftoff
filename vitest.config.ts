import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Several tests have timing budgets (ingest) or start real shells and node
    // processes; fewer workers keep them from starving each other (Task 15).
    maxWorkers: 4,
    projects: [
      {
        test: {
          name: 'unit',
          include: ['tests/**/*.test.ts'],
          exclude: ['tests/e2e/**'],
          // Many tests start real processes (shells, node, git); with the
          // whole suite running in parallel, 5 s is too tight (Task 14).
          testTimeout: 20_000,
        },
      },
      {
        test: {
          name: 'e2e',
          include: ['tests/e2e/**/*.test.ts'],
        },
      },
    ],
  },
});
