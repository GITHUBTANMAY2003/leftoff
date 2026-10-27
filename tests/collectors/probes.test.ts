import { expect, test } from 'vitest';
import {
  isProbeCommand,
  isProbeFailure,
  isReadOnlyTool,
  PROBE_COMMANDS,
} from '../../src/collectors/probes.ts';

test.each([
  ['ls /nope', 1],
  ['ls -la build', 2],
  ['cat notes.md', 1],
  ['head -n 5 missing.log', 1],
  ['tail -f nothing.log', 1],
  ['stat config.yml', 1],
  ['test -f .env', 1],
  ['[ -d dist ]', 1],
  ['which pnpm', 1],
  ['command -v bun', 1],
  ['type deno', 1],
  ['grep -q TODO src/app.ts', 1],
  ['grep -rn "secret" .', 1],
  ["rg --files -g 'notes.md'", 1],
  ['ag needle', 1],
  ['find . -name "*.orig"', 1],
  ['fd config', 1],
  ['git show HEAD~3:README.md', 1],
  ['git rev-parse --verify feature/x', 1],
  ['git ls-files --error-unmatch a.txt', 1],
  ['git cat-file -e abc123', 1],
  ['diff a.txt b.txt', 1],
  ['cmp a.bin b.bin', 2],
  // exit 1 means "differences found" (owner decision after Task 13)
  ['git diff --no-index -- /dev/null tests/test_x.py', 1],
  ['git diff --exit-code', 1],
  ['git diff --stat HEAD~1', 1],
  ['cat calc.js && cat calc.test.js', 1], // every part is a probe
  ['rg TODO | head -20', 1],
  ['cd src && ls missing', 1],
  ['LC_ALL=C grep -c x file', 1],
])('%j exiting %i is a probe failure', (command, exitCode) => {
  expect(isProbeFailure(command, exitCode, '')).toBe(true);
});

test.each([
  ['npm test', 1], // not a probe command
  ['ls /nope', 127], // command not found: a real problem
  ['grep x file', 126], // not executable
  ['rg needle', 130], // interrupted
  ['git rev-parse --verify main', 128], // git's "fatal" exit code
  ['ls && npm run build', 1], // one part isn't a probe
  ['git commit -m wip', 1], // git, but not a read-only subcommand
  ['catalog-tool list', 1], // "cat" only as a whole word
  ['lsof -i :3000', 1],
])('%j exiting %i still counts', (command, exitCode) => {
  expect(isProbeFailure(command, exitCode, '')).toBe(false);
});

test('a probe whose output looks like a failed test run still counts', () => {
  expect(isProbeFailure('cat test-results.txt', 1, 'Tests: 2 failed, 10 passed')).toBe(false);
  expect(isProbeFailure('grep FAIL report.log', 1, '--- FAIL: TestLogin (0.01s)')).toBe(false);
});

test('read-only agent tools', () => {
  for (const tool of ['Read', 'Glob', 'Grep', 'LS']) expect(isReadOnlyTool(tool)).toBe(true);
  for (const tool of ['Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'Bash', 'WebFetch', null]) {
    expect(isReadOnlyTool(tool)).toBe(false);
  }
});

test('isProbeCommand ignores leading env assignments and whitespace', () => {
  expect(isProbeCommand('  FOO=1   ls   x ')).toBe(true);
  expect(isProbeCommand('')).toBe(false);
});

test('the list is in one place and names every command it covers', () => {
  expect(PROBE_COMMANDS).toEqual(
    expect.arrayContaining([
      'ls',
      'cat',
      'grep',
      'rg',
      'find',
      'git show',
      'git rev-parse',
      'command -v',
    ]),
  );
});
