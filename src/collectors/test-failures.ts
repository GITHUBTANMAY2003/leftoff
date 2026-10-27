import { endsWithTrimmingPipe } from '../model/event.ts';

// How leftoff recognizes a failed test run in command output (test_failed
// events). Deterministic: plain regular expressions, no AI. To support another
// framework, add an entry here with a test case in
// tests/collectors/test-failures.test.ts, including its passing (zero) output.
// Patterns must not use the `g` flag (it makes RegExp.test stateful).

export const TEST_FAILURE_PATTERNS: { name: string; pattern: RegExp }[] = [
  // pytest "1 failed", jest "Tests: 2 failed", vitest "1 failed", mocha "1 failing"
  { name: 'N failed / N failing (N ≥ 1)', pattern: /\b[1-9]\d* (failed|failing)\b/ },
  // Node's test runner summary and TAP output
  { name: 'node test runner: ℹ fail N (N ≥ 1)', pattern: /^ℹ fail [1-9]\d*/m },
  { name: 'TAP: # fail N (N ≥ 1)', pattern: /^# fail [1-9]\d*/m },
  // go test: "--- FAIL: TestX", and a final "FAIL" / "FAIL\tpkg" line; jest "FAIL src/x.test.js"
  { name: 'go test: --- FAIL:', pattern: /^--- FAIL:/m },
  { name: 'FAIL at the start of a line (go, jest)', pattern: /^\s*FAIL\b/m },
  // cargo test
  { name: 'cargo: test result: FAILED', pattern: /test result: FAILED/ },
  // Node/Python assertion failures
  { name: 'AssertionError', pattern: /\bAssertionError\b/ },
];

export function looksLikeTestFailure(output: string): boolean {
  return TEST_FAILURE_PATTERNS.some((p) => p.pattern.test(output));
}

// A command that exited 0 only because its output went through `| tail` (or
// head, cat, less), while that output shows a failed test run (owner decision
// after Task 11). Without such a pipe, exit 0 is trusted.
export function isMaskedTestFailure(command: string, output: string): boolean {
  return endsWithTrimmingPipe(command) && looksLikeTestFailure(output);
}
