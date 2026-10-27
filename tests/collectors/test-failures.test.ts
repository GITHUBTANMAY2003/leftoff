import { expect, test } from 'vitest';
import { looksLikeTestFailure, TEST_FAILURE_PATTERNS } from '../../src/collectors/test-failures.ts';

test.each([
  ['node test runner', 'ℹ tests 3\nℹ pass 2\nℹ fail 1\nℹ cancelled 0'],
  ['node test runner, many', 'ℹ fail 12'],
  ['TAP', 'ok 1 - a\nnot ok 2 - b\n# tests 2\n# pass 1\n# fail 1'],
  ['go test, one test', '=== RUN   TestAdd\n--- FAIL: TestAdd (0.00s)\n    add_test.go:9: got -1'],
  ['go test, package line', 'FAIL\tgithub.com/acme/calc\t0.012s'],
  ['go test, final FAIL', '--- PASS: TestA (0.00s)\nFAIL\nexit status 1'],
  ['cargo test', 'running 2 tests\ntest add ... FAILED\n\ntest result: FAILED. 1 passed; 1 failed'],
  ['pytest', '==== 1 failed, 3 passed in 0.12s ===='],
  ['jest summary', 'Tests:       2 failed, 5 passed, 7 total'],
  ['jest file header', ' FAIL  src/calc.test.js\n  ● add › adds'],
  ['vitest', ' Test Files  1 failed (1)\n      Tests  1 failed | 4 passed (5)'],
  ['mocha', '  3 passing (12ms)\n  1 failing'],
  ['assertion error', 'AssertionError [ERR_ASSERTION]: Expected values to be strictly equal'],
])('%s: a failing run is recognized', (_name, output) => {
  expect(looksLikeTestFailure(output)).toBe(true);
});

test.each([
  ['node test runner, all pass', 'ℹ tests 3\nℹ pass 3\nℹ fail 0\nℹ cancelled 0'],
  ['TAP, all pass', '# tests 2\n# pass 2\n# fail 0'],
  ['go test, pass', '--- PASS: TestAdd (0.00s)\nPASS\nok  \tgithub.com/acme/calc\t0.010s'],
  ['cargo, pass', 'test result: ok. 2 passed; 0 failed; 0 ignored'],
  ['pytest, pass', '==== 4 passed in 0.10s ===='],
  ['vitest, zero failed', 'Tests  0 failed | 5 passed (5)'],
  ['jest, pass', ' PASS  src/calc.test.js\nTests:       7 passed, 7 total'],
  ['mocha, zero failing', '  3 passing (12ms)\n  0 failing'],
  [
    'words that contain FAIL',
    'FAILOVER configured; failsafe on; npm WARN failed-to-fetch metadata',
  ],
  ['not a test run', 'npm error Missing script: "lint"'],
])('%s: not a test failure', (_name, output) => {
  expect(looksLikeTestFailure(output)).toBe(false);
});

test('every pattern is named and is a plain RegExp (one place for contributors)', () => {
  expect(TEST_FAILURE_PATTERNS.length).toBeGreaterThan(0);
  for (const p of TEST_FAILURE_PATTERNS) {
    expect(typeof p.name).toBe('string');
    expect(p.pattern).toBeInstanceOf(RegExp);
    expect(p.pattern.global).toBe(false); // global regexes keep state between .test() calls
  }
});
