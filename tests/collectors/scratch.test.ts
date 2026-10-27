import { expect, test } from 'vitest';
import { isScratchCommand } from '../../src/collectors/scratch.ts';
import { commandKey } from '../../src/model/event.ts';

// Scratch work (owner decision after Task 13): one-off agent commands whose
// failures are not open problems.
test.each([
  ["python3 - <<'EOF'\nprint(1)\nEOF", true], // heredoc (and multi-line)
  ['cat <<EOF > f.txt', true],
  ['python -c "import x"', true],
  ['python3 -c "import x"', true],
  ['node -e "require(1)"', true],
  ['node --eval "1"', true],
  ['bash -c "npm test"', true],
  ['sh -c "make"', true],
  ['npm test\nnpm run lint', true], // multi-line
  ['grep -n foo src/a.ts | head -3 | wc -l', true], // pipeline starting with a text tool
  ['cat package.json | jq .scripts', true],
  ['cd /x && rg foo | sort', true],
  ['find . -name "*.ts" | xargs wc -l', true],
  ["nl -ba src/index.ts | sed -n '135,192p'", true],
  ['npm test', false],
  ['npx vitest run tests/a.test.ts', false],
  ['npm test 2>&1 | grep FAIL', false], // first program is npm: a project command
  ['make deploy', false],
  ['python scripts/send_test_email.py', false],
  ['grep -q foo a.txt', false], // a lone grep is a probe, not scratch
  ['echo "a | b"', false], // the pipe is inside quotes
])('isScratchCommand(%j) → %s', (command, expected) => {
  expect(isScratchCommand(command)).toBe(expected);
});

test.each([
  ['npx vitest run tests/a.test.ts', 'vitest run'],
  ['npx vitest run', 'vitest run'],
  ['npm test -- --grep x', 'npm test'],
  ['npm run lint', 'npm run lint'],
  ['npm run build -- --watch', 'npm run build'],
  ['python scripts/send_test_email.py --dry', 'python scripts/send_test_email.py'],
  ['pytest tests/test_reset.py -x', 'pytest tests/test_reset.py'],
  ['node --test', 'node --test'],
  ['cargo test foo', 'cargo test foo'],
  ['CI=1 npm test 2>&1 | tail -5', 'npm test'],
  ['make', 'make'],
  // Found on real data (owner's ~/.leftoff): setup steps and runner prefixes are
  // not the program; a chain of several steps only matches itself.
  ['source "$HOME/.cargo/env" && cargo test -p looplint_adapters', 'cargo test'],
  ['export A=1 && set -e && make deploy', 'make deploy'],
  ['uv run --no-sync ruff format --check src/a.py', 'ruff format'],
  ['uv run ruff check src/dasquake/streaming.py', 'ruff check'],
  ['pnpm exec tsc --noEmit --pretty false', 'tsc --noEmit'],
  ['npx --yes --package=node@24.22.1 --package=pnpm@11.3.0 pnpm doctor', 'pnpm doctor'],
  ['npx --no-install eslint .', 'eslint .'],
  [
    'git status --short && uv run ruff check src tests && uv run pytest',
    'git status --short && uv run ruff check src tests && uv run pytest',
  ],
  ['npm run build; npm test', 'npm run build; npm test'],
  // A single pipeline into a filter is the command before the filter.
  ['npx vitest run --project unit 2>&1 | grep -E -A15 "FAIL " | head -40', 'vitest run'],
  ['npm test | grep -c passed', 'npm test'],
  ['git diff --check\ngit status --short', 'git diff --check git status --short'], // multi-line: itself only
])('commandKey(%j) → %j', (command, expected) => {
  expect(commandKey(command)).toBe(expected);
});
