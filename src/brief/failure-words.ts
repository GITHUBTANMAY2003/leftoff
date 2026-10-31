import { basename } from 'node:path';
import { chainSteps, commandFiles, displayCommand, programWords } from '../model/event.ts';

// Failures in plain words (Task 15b): "the billing tests are failing" instead
// of a raw command line. Deterministic, one data table: a tool pattern gives a
// category and a label, the category gives the phrase. To support another
// tool, add a row to TOOLS (or SCRIPTS for package-manager scripts) with a
// case in tests/brief/failure-words.test.ts. The category also decides which
// failures a passing whole-project run resolves (facts.ts).

export type FailureCategory =
  'test' | 'lint' | 'format' | 'typecheck' | 'build' | 'check' | 'make' | 'docker' | 'missing';

export interface FailureWords {
  category: FailureCategory | null;
  now: string; // "the billing tests are failing"
  still: string; // "the billing tests are still failing"
  fix: string; // "Make the billing tests pass (`pytest tests/test_billing.py`)"
}

// Matched against the program words (setup steps, runners and trailing filters
// gone; the program as its base name): `npx vitest run x` → "vitest run x".
// First match wins. A null label means the phrase names no tool.
const TOOLS: { pattern: RegExp; category: FailureCategory; label: string | null }[] = [
  // formatters in check mode (before their linters: `ruff format --check`)
  { pattern: /^cargo fmt\b.*--check/, category: 'format', label: 'rustfmt' },
  { pattern: /^ruff format\b.*--check/, category: 'format', label: 'Ruff' },
  {
    pattern: /^prettier\b.*(--check|--list-different|-c\b|-l\b)/,
    category: 'format',
    label: 'Prettier',
  },
  { pattern: /^black\b.*--check/, category: 'format', label: 'Black' },
  // test runners
  { pattern: /^pytest\b/, category: 'test', label: 'Python' },
  { pattern: /^jest\b/, category: 'test', label: 'Jest' },
  { pattern: /^vitest\b/, category: 'test', label: 'Vitest' },
  { pattern: /^mocha\b/, category: 'test', label: 'Mocha' },
  { pattern: /^node --test\b/, category: 'test', label: 'Node' },
  { pattern: /^go test\b/, category: 'test', label: 'Go' },
  { pattern: /^cargo (test|nextest)\b/, category: 'test', label: 'Rust' },
  { pattern: /^gradlew? (\S+ )*(\S+:)?test\b/, category: 'test', label: 'Gradle' },
  { pattern: /^mvnw? (\S+ )*test\b/, category: 'test', label: 'Maven' },
  // linters
  { pattern: /^ruff\b/, category: 'lint', label: 'Ruff' },
  { pattern: /^eslint\b/, category: 'lint', label: 'ESLint' },
  { pattern: /^flake8\b/, category: 'lint', label: 'flake8' },
  { pattern: /^pylint\b/, category: 'lint', label: 'Pylint' },
  { pattern: /^golangci-lint\b/, category: 'lint', label: 'golangci-lint' },
  { pattern: /^cargo clippy\b/, category: 'lint', label: 'Clippy' },
  { pattern: /^biome (lint|check)\b/, category: 'lint', label: 'Biome' },
  // type checkers
  { pattern: /^(tsc|vue-tsc)\b/, category: 'typecheck', label: 'TypeScript' },
  { pattern: /^mypy\b/, category: 'typecheck', label: 'mypy' },
  { pattern: /^pyright\b/, category: 'typecheck', label: 'Pyright' },
  // builds
  { pattern: /^(vite|next|nuxt|astro|ng) build\b/, category: 'build', label: null },
  { pattern: /^(webpack|tsup|rollup|esbuild|parcel build)\b/, category: 'build', label: null },
  { pattern: /^(cargo|go|swift|dotnet) build\b/, category: 'build', label: null },
  { pattern: /^cargo check\b/, category: 'build', label: null },
  { pattern: /^gradlew? (\S+ )*(build|assemble)\b/, category: 'build', label: null },
  { pattern: /^mvnw? (\S+ )*(package|install|compile|verify)\b/, category: 'build', label: null },
  { pattern: /^docker (buildx )?build\b|^docker compose build\b/, category: 'docker', label: null },
];

// Package-manager scripts (`npm run lint`, `pnpm test:e2e`) by script name.
const SCRIPTS: { pattern: RegExp; category: FailureCategory }[] = [
  { pattern: /^(test|t)$|^test:|:test$/, category: 'test' },
  { pattern: /^(format|fmt):check$|^(format|fmt)-check$/, category: 'format' },
  { pattern: /^lint$|^lint:/, category: 'lint' },
  { pattern: /^(typecheck|type-check|types|tsc)$/, category: 'typecheck' },
  { pattern: /^build$|^build:/, category: 'build' },
  { pattern: /^check$|^check:/, category: 'check' },
];
const PACKAGE_MANAGERS = new Set(['npm', 'pnpm', 'yarn', 'bun']);
// Their own subcommands, which are never scripts (`pnpm install`).
const PM_COMMANDS = new Set(['install', 'i', 'ci', 'add', 'remove', 'publish', 'exec', 'dlx', 'x']);
const MAKE_TARGETS: Record<string, FailureCategory> = {
  test: 'test',
  tests: 'test',
  lint: 'lint',
  check: 'check',
  build: 'build',
};

// Errors that say what is missing, whatever the tool (checked first).
const MISSING_SCRIPT = /Missing script:\s*"?([^"\s]+)"?/;
const MISSING_COMMAND = [
  /command not found: (\S+)/, // zsh
  /([^\s:]+): command not found/, // bash
  /:\s*\d+:\s*([^\s:]+): not found/, // sh / dash
];

// Program words with the program's base name (`./gradlew` → `gradlew`) and
// `python -m` dropped (`python -m pytest` → `pytest`).
function wordsOf(command: string): string[] {
  let words = programWords(command) ?? displayCommand(command).split(' ');
  if (/^python[\d.]*$/.test(words[0] ?? '') && words[1] === '-m') words = words.slice(2);
  return words.length > 0 ? [basename(words[0] as string), ...words.slice(1)] : words;
}

function classify(command: string): { category: FailureCategory; label: string | null } | null {
  const words = wordsOf(command);
  const [program = '', first = '', second = ''] = words;
  if (PACKAGE_MANAGERS.has(program) && !PM_COMMANDS.has(first)) {
    const script = first === 'run' ? second : first;
    const row = SCRIPTS.find((s) => s.pattern.test(script));
    return row ? { category: row.category, label: null } : null;
  }
  if (program === 'make') {
    const category = MAKE_TARGETS[first];
    return { category: category ?? 'make', label: null };
  }
  const line = words.join(' ');
  const row = TOOLS.find((t) => t.pattern.test(line));
  return row ? { category: row.category, label: row.label } : null;
}

export function failureCategory(command: string): FailureCategory | null {
  return classify(command)?.category ?? null;
}

// Flags that run part of a suite (a test name, a marker, a package).
const PART_FLAGS = new Set([
  '-k',
  '-m',
  '-t',
  '-g',
  '--grep',
  '--testNamePattern',
  '-run',
  '-p',
  '--package',
  '-pl',
  '--filter',
]);
const WHOLE_TREE = new Set(['.', './...', '...']);

// A run of the project's whole check (Task 15b B): a test/lint/format/type/
// build/check command with no file arguments, no test filter and nothing after
// `--`. Its success resolves every earlier failure of the same category.
export function isWholeProjectRun(command: string): boolean {
  const category = failureCategory(command);
  if (category === null || category === 'missing' || category === 'docker') return false;
  if (category === 'make') return false;
  const words = wordsOf(command);
  if (words.includes('--') && words.indexOf('--') < words.length - 1) {
    // cargo passes flags after `--` to the test binary; a name there is a filter
    const after = words.slice(words.indexOf('--') + 1);
    if (after.some((w) => !w.startsWith('-'))) return false;
  }
  if (words.some((w) => PART_FLAGS.has(w))) return false;
  return commandFiles(command).every((f) => WHOLE_TREE.has(f));
}

const ALL_CHECKS: FailureCategory[] = ['test', 'lint', 'format', 'typecheck', 'build', 'check'];
export function resolvedCategories(category: FailureCategory): FailureCategory[] {
  return category === 'check' ? ALL_CHECKS : [category];
}

// "the reset tests": a package (`-p billing_core`) or the test files' names
// (`tests/test_reset.py` → reset), at most two; else the runner's label.
function testSubject(command: string, label: string | null): string {
  const words = wordsOf(command);
  const flag = words.findIndex((w) => w === '-p' || w === '--package' || w === '-pl');
  let scope = flag >= 0 ? (words[flag + 1] ?? '') : '';
  if (scope === '') {
    const names = commandFiles(command)
      .map((f) =>
        basename(f)
          .replace(/\.[^.]+$/, '')
          .replace(/([._-](test|spec))+$/i, '')
          .replace(/^test_/, ''),
      )
      .filter((n) => /\w/.test(n));
    scope = names.length > 2 ? `${names[0]}, ${names[1]} and other` : names.join(' and ');
  }
  if (scope !== '') return `the ${scope} tests`;
  return label ? `the ${label} tests` : 'the tests';
}

// Exit codes that say what happened to the process.
const EXIT_CODES: Record<string, { now: string; fix: string }> = {
  '137': { now: 'was killed (exit code 137, often out of memory)', fix: 'Find out why' },
  '139': { now: 'crashed (exit code 139, a segmentation fault)', fix: 'Find out why' },
  '126': { now: 'could not run (exit code 126, not executable)', fix: 'Check' },
};

export function describeFailure(command: string | null, error: string): FailureWords {
  // A chain of checks (`cargo fmt …; cargo test …`) reads as its last check.
  if (command !== null) {
    const steps = chainSteps(displayCommand(command));
    const check = [...steps].reverse().find((step) => classify(step) !== null);
    if (steps.length > 1 && check !== undefined) return describeFailure(check, error);
  }
  const script = MISSING_SCRIPT.exec(error)?.[1];
  if (script !== undefined) {
    return {
      category: 'missing',
      now: `there is no "${script}" script in package.json`,
      still: `there is still no "${script}" script in package.json`,
      fix: `Add a "${script}" script to package.json, or stop calling it`,
    };
  }
  for (const pattern of MISSING_COMMAND) {
    const program = pattern.exec(error)?.[1];
    if (program === undefined) continue;
    return {
      category: 'missing',
      now: `\`${program}\` is not installed`,
      still: `\`${program}\` is still not installed`,
      fix: `Install \`${program}\``,
    };
  }
  if (command === null) {
    return { category: null, now: error, still: `${error} (still failing)`, fix: `Fix: ${error}` };
  }
  const shown = displayCommand(command);
  const kind = classify(command);
  const run = `(\`${shown}\`)`;
  switch (kind?.category) {
    case 'test': {
      const subject = testSubject(command, kind.label);
      return {
        category: 'test',
        now: `${subject} are failing`,
        still: `${subject} are still failing`,
        fix: `Make ${subject} pass ${run}`,
      };
    }
    case 'lint':
      return kind.label
        ? {
            category: 'lint',
            now: `${kind.label} reports lint errors`,
            still: `${kind.label} still reports lint errors`,
            fix: `Fix the ${kind.label} errors ${run}`,
          }
        : {
            category: 'lint',
            now: 'the linter reports errors',
            still: 'the linter still reports errors',
            fix: `Fix the lint errors ${run}`,
          };
    case 'format': {
      const tool = kind.label ?? 'the formatter';
      return {
        category: 'format',
        now: `${tool} finds unformatted files`,
        still: `${tool} still finds unformatted files`,
        fix: `Format the files ${run}`,
      };
    }
    case 'typecheck':
      return kind.label
        ? {
            category: 'typecheck',
            now: `${kind.label} reports type errors`,
            still: `${kind.label} still reports type errors`,
            fix: `Fix the type errors ${run}`,
          }
        : {
            category: 'typecheck',
            now: 'the type check fails',
            still: 'the type check still fails',
            fix: `Fix the type errors ${run}`,
          };
    case 'build':
      return {
        category: 'build',
        now: 'the build fails',
        still: 'the build still fails',
        fix: `Fix the build ${run}`,
      };
    case 'check':
      return {
        category: 'check',
        now: 'the project checks fail',
        still: 'the project checks still fail',
        fix: `Make the project checks pass ${run}`,
      };
    case 'make':
      return {
        category: 'make',
        now: `\`${shown}\` fails`,
        still: `\`${shown}\` still fails`,
        fix: `Get \`${shown}\` working (${error})`,
      };
    case 'docker':
      return {
        category: 'docker',
        now: 'the Docker build fails',
        still: 'the Docker build still fails',
        fix: `Fix the Docker build ${run}`,
      };
    default: {
      const exit = EXIT_CODES[/^exit code (\d+)$/.exec(error)?.[1] ?? ''];
      if (exit) {
        return {
          category: null,
          now: `\`${shown}\` ${exit.now}`,
          still: `\`${shown}\` still ${exit.now
            .replace(/^was /, 'gets ')
            .replace(/^crashed/, 'crashes')
            .replace(/^could not/, 'cannot')}`,
          fix: `${exit.fix} \`${shown}\` ${exit.now.split(' (')[0]}`,
        };
      }
      return {
        category: null,
        now: `\`${shown}\` — ${error}`,
        still: `\`${shown}\` still fails — ${error}`,
        fix: `Get \`${shown}\` working (${error})`,
      };
    }
  }
}
