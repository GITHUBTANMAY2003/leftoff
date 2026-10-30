import { describe, expect, test } from 'vitest';
import {
  describeFailure,
  failureCategory,
  isWholeProjectRun,
  resolvedCategories,
} from '../../src/brief/failure-words.ts';

// Failures in plain words (Task 15b C): one data table, tool pattern →
// category → phrase. Every ecosystem has a row here, plus the fallback.

describe('describeFailure: test runners', () => {
  test.each([
    ['pytest', 'pytest tests/test_reset.py', 'the reset tests'],
    ['pytest (python -m)', 'python -m pytest', 'the Python tests'],
    ['pytest via uv run', 'uv run pytest -q', 'the Python tests'],
    ['jest', 'npx jest src/cart.test.js', 'the cart tests'],
    ['vitest', 'npx vitest run tests/cli/doctor.test.ts', 'the doctor tests'],
    ['vitest, two files', 'vitest run tests/a.test.ts tests/b.spec.ts', 'the a and b tests'],
    ['mocha', 'mocha test/api.spec.js', 'the api tests'],
    ['node --test', 'node --test', 'the Node tests'],
    ['go test', 'go test ./...', 'the Go tests'],
    ['go test, one file', 'go test ./parser/lexer_test.go', 'the lexer tests'],
    ['cargo test', 'cargo test', 'the Rust tests'],
    ['cargo test -p', 'cargo test -p billing_core', 'the billing_core tests'],
    ['gradle', './gradlew test', 'the Gradle tests'],
    ['maven', 'mvn test', 'the Maven tests'],
    ['npm test', 'npm test', 'the tests'],
    ['package script', 'pnpm test:e2e', 'the tests'],
    ['make test', 'make test', 'the tests'],
  ])('%s', (_name, command, subject) => {
    const words = describeFailure(command, '2 failed, 10 passed');
    expect(words.category).toBe('test');
    expect(words.now).toBe(`${subject} are failing`);
    expect(words.still).toBe(`${subject} are still failing`);
    expect(words.fix).toBe(`Make ${subject} pass (\`${command}\`)`);
  });
});

describe('describeFailure: linters, formatters, type checkers, builds', () => {
  test.each([
    [
      'ruff',
      'ruff check src',
      'lint',
      'Ruff reports lint errors',
      'Ruff still reports lint errors',
    ],
    [
      'eslint',
      'npx eslint .',
      'lint',
      'ESLint reports lint errors',
      'ESLint still reports lint errors',
    ],
    [
      'flake8',
      'flake8 app',
      'lint',
      'flake8 reports lint errors',
      'flake8 still reports lint errors',
    ],
    [
      'golangci-lint',
      'golangci-lint run',
      'lint',
      'golangci-lint reports lint errors',
      'golangci-lint still reports lint errors',
    ],
    [
      'clippy',
      'cargo clippy -- -D warnings',
      'lint',
      'Clippy reports lint errors',
      'Clippy still reports lint errors',
    ],
    [
      'npm run lint',
      'npm run lint',
      'lint',
      'the linter reports errors',
      'the linter still reports errors',
    ],
    [
      'prettier --check',
      'npx prettier --check .',
      'format',
      'Prettier finds unformatted files',
      'Prettier still finds unformatted files',
    ],
    [
      'ruff format --check',
      'ruff format --check app.py',
      'format',
      'Ruff finds unformatted files',
      'Ruff still finds unformatted files',
    ],
    [
      'cargo fmt --check',
      'cargo fmt --check',
      'format',
      'rustfmt finds unformatted files',
      'rustfmt still finds unformatted files',
    ],
    [
      'tsc',
      'npx tsc --noEmit',
      'typecheck',
      'TypeScript reports type errors',
      'TypeScript still reports type errors',
    ],
    ['mypy', 'mypy src', 'typecheck', 'mypy reports type errors', 'mypy still reports type errors'],
    [
      'npm run typecheck',
      'npm run typecheck',
      'typecheck',
      'the type check fails',
      'the type check still fails',
    ],
    ['npm run build', 'npm run build', 'build', 'the build fails', 'the build still fails'],
    ['vite build', 'npx vite build', 'build', 'the build fails', 'the build still fails'],
    ['cargo build', 'cargo build --release', 'build', 'the build fails', 'the build still fails'],
    ['go build', 'go build ./...', 'build', 'the build fails', 'the build still fails'],
    ['gradle build', './gradlew build', 'build', 'the build fails', 'the build still fails'],
    ['mvn package', 'mvn package', 'build', 'the build fails', 'the build still fails'],
    [
      'npm run check',
      'npm run check',
      'check',
      'the project checks fail',
      'the project checks still fail',
    ],
    ['make', 'make deploy', 'make', '`make deploy` fails', '`make deploy` still fails'],
    [
      'docker build',
      'docker build -t app .',
      'docker',
      'the Docker build fails',
      'the Docker build still fails',
    ],
  ])('%s', (_name, command, category, now, still) => {
    const words = describeFailure(command, 'error: something');
    expect(words.category).toBe(category);
    expect(words.now).toBe(now);
    expect(words.still).toBe(still);
  });
});

describe('describeFailure: missing script or command', () => {
  test('a missing package script', () => {
    const words = describeFailure('npm run lint', 'npm error Missing script: "lint"');
    expect(words.category).toBe('missing');
    expect(words.now).toBe('there is no "lint" script in package.json');
    expect(words.still).toBe('there is still no "lint" script in package.json');
    expect(words.fix).toBe('Add a "lint" script to package.json, or stop calling it');
  });

  test.each([
    ['zsh: command not found: pnpm', 'pnpm'],
    ['bash: pnpm: command not found', 'pnpm'],
    ['/bin/sh: 1: pnpm: not found', 'pnpm'],
  ])('a missing command: %s', (error, program) => {
    const words = describeFailure('pnpm install', error);
    expect(words.category).toBe('missing');
    expect(words.now).toBe(`\`${program}\` is not installed`);
    expect(words.still).toBe(`\`${program}\` is still not installed`);
    expect(words.fix).toBe(`Install \`${program}\``);
  });
});

describe('describeFailure: fallback', () => {
  test('an unknown tool reads as the cleaned command and its error', () => {
    const words = describeFailure(
      'cd /src/app && source .env && ./deploy.sh --stage 2>&1 | tail -20',
      'connection refused',
    );
    expect(words.category).toBeNull();
    expect(words.now).toBe('`./deploy.sh --stage` — connection refused');
    expect(words.still).toBe('`./deploy.sh --stage` still fails — connection refused');
    expect(words.fix).toBe('Get `./deploy.sh --stage` working (connection refused)');
  });

  test('no command: the error alone', () => {
    const words = describeFailure(null, 'Edit failed: file changed on disk');
    expect(words.now).toBe('Edit failed: file changed on disk');
    expect(words.still).toBe('Edit failed: file changed on disk (still failing)');
  });

  test('a test failure seen in output of an unknown tool is still described by its command', () => {
    expect(describeFailure('./run-suite.sh', '1 failed').category).toBeNull();
  });
});

describe('categories for resolution', () => {
  test('failureCategory ignores setup steps, runners and trailing filters', () => {
    expect(failureCategory('source .venv/bin/activate && pytest -x | tail -5')).toBe('test');
    expect(failureCategory('git push')).toBeNull();
  });

  test('a whole-project run has no file arguments and no test filters', () => {
    expect(isWholeProjectRun('npm test')).toBe(true);
    expect(isWholeProjectRun('npx vitest run --project unit')).toBe(true);
    expect(isWholeProjectRun('cargo test --workspace')).toBe(true);
    expect(isWholeProjectRun('npx vitest run tests/a.test.ts')).toBe(false);
    expect(isWholeProjectRun('pytest -k reset')).toBe(false);
    expect(isWholeProjectRun('cargo test -p billing_core')).toBe(false);
    expect(isWholeProjectRun('cargo test -- star_import')).toBe(false);
    expect(isWholeProjectRun('go test -run TestLexer ./...')).toBe(false);
    expect(isWholeProjectRun('git push')).toBe(false); // not a check at all
  });

  test('a check script covers tests, lint, formatting, types and the build', () => {
    expect(resolvedCategories('check').sort()).toEqual(
      ['build', 'check', 'format', 'lint', 'test', 'typecheck'].sort(),
    );
    expect(resolvedCategories('test')).toEqual(['test']);
  });
});
