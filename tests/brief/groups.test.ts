import { expect, test } from 'vitest';
import type { OpenProblem } from '../../src/brief/facts.ts';
import { groupProblems } from '../../src/brief/groups.ts';

// One way to group open problems, used by every view (owner decision after
// 15d): test failures of a project merge into one sentence naming the
// packages or suites; formatting failures merge; the rest group by how they
// read. Sentences start with a capital letter.

const p = (command: string | null, error: string, isTest = false): OpenProblem => ({
  error,
  command,
  isTest,
  source: 'claude',
  firstSeen: '2026-10-20T10:00:00.000Z',
  attempts: [],
});

test('test failures in several packages are one group; a workspace-wide run is not listed separately', () => {
  const groups = groupProblems([
    p('cargo test -p billing_adapters', 'failed', true),
    p('cargo fmt --all; cargo test --workspace | grep FAILED', 'failed', true),
    p('cargo test -p billing_adapters --test openai -- star_import', 'failed', true),
    p('cargo test -p billing_semantic --test dataflow', 'failed', true),
  ]);
  expect(groups).toHaveLength(1);
  expect(groups[0]).toMatchObject({
    now: 'Tests fail in 2 packages: billing_adapters and billing_semantic',
    still: 'tests still fail in 2 packages: billing_adapters and billing_semantic',
    action: 'make the tests pass in billing_adapters and billing_semantic',
    rerun: 'cargo test --workspace',
  });
  expect(groups[0]?.problems).toHaveLength(4);
});

test('tests in one suite, or with no scope', () => {
  expect(groupProblems([p('pytest tests/test_reset.py', '1 failed', true)])[0]).toMatchObject({
    now: 'The reset tests are failing',
    action: 'make the reset tests pass',
    rerun: 'pytest tests/test_reset.py',
  });
  expect(groupProblems([p('go test ./...', 'FAIL', true)])[0]?.now).toBe(
    'The Go tests are failing',
  );
});

test('formatting failures merge and count their files', () => {
  const groups = groupProblems([
    p('uv run ruff format --check src/a.py src/b.py', 'Would reformat: src/a.py'),
    p('uv run ruff format --check tests/t.py src/a.py', 'Would reformat: tests/t.py'),
  ]);
  expect(groups).toHaveLength(1);
  expect(groups[0]).toMatchObject({ now: '3 files need formatting', action: 'format the 3 files' });
});

test('known error texts are put in words; the raw line stays on the problem', () => {
  const [g] = groupProblems([p('make run-ci', 'ERROR collecting tests/test_kernel.py')]);
  expect(g).toMatchObject({
    now: "The project checks fail: pytest can't load tests/test_kernel.py",
    action: 'fix the test-loading error in tests/test_kernel.py',
    rerun: 'make run-ci',
  });
  expect(g?.problems[0]?.error).toBe('ERROR collecting tests/test_kernel.py');
});

test('other problems group by how they read, newest first', () => {
  const groups = groupProblems([
    p('./deploy.sh', 'connection refused'),
    p('npm run lint', 'npm error Missing script: "lint"'),
    p('./deploy.sh --stage', 'connection refused'),
  ]);
  expect(groups.map((g) => g.now)).toEqual([
    '`./deploy.sh` — connection refused',
    'There is no "lint" script in package.json',
    '`./deploy.sh --stage` — connection refused',
  ]);
});
