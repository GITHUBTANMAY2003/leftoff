# Task 01: Project scaffold, paths, config, logger

## 1. Goal

From the plan (Task 1): create the project scaffold (package, TypeScript, build, test, lint, format, CI) and the four core modules every later task uses:

- `paths()` / `ensureHome()`: where leftoff keeps its data (P4), honoring `LEFTOFF_HOME`;
- `Config`: `loadConfig` / `saveConfig` / `getConfigValue` / `setConfigValue`, with a hand-written validator and the full shape agreed in R-B9;
- `logError` / `readRecentErrors`: the error log, rotated at 1 MB with 2 files kept (§1.11);
- `withBudget`: the time-budget helper used by hooks and ingest (§1.11).

Plan Step 1 asks for the scaffold: `package.json` with name, `bin`, `publishConfig`, `engines >=22.12`, the scripts from Global Constraints, TypeScript pinned to `~6.0.3`, a `tsconfig` with the R-A5 import flags, vitest `unit`/`e2e` projects, and CI on ubuntu/macos × Node 22/24/26.

Before this task, the plan itself was updated with all plan-review decisions in commit `11c35e4` ("docs: apply plan review decisions").

## 2. Files

| File | Purpose |
|---|---|
| `package.json` | Package identity (`@leftoff-dev/cli`, bin `leftoff` → `dist/cli.js`), engines, scripts, dependencies |
| `package-lock.json` | Locked dependency tree (for `npm ci` in CI) |
| `tsconfig.json` | Strict TypeScript, NodeNext ESM, `.ts` imports, `erasableSyntaxOnly`, no emit (tsup builds) |
| `tsup.config.ts` | Bundles `src/cli/index.ts` → `dist/cli.js` (ESM, node22 target, `#!/usr/bin/env node` banner) |
| `vitest.config.ts` | Two test projects: `unit` (`tests/**` except `tests/e2e`) and `e2e` (`tests/e2e/**`) |
| `eslint.config.js` | Flat config: `@eslint/js` recommended + `typescript-eslint` recommended |
| `.prettierrc` | Prettier style: single quotes, 100-column lines |
| `.prettierignore` | Keeps `docs/`, `tests/fixtures/`, `dist/`, `coverage/`, `package-lock.json` out of formatting |
| `.gitignore` | Ignores `node_modules/`, `dist/`, `coverage/` |
| `.github/workflows/ci.yml` | CI: ubuntu + macos × Node 22/24/26; installs zsh+fish (Linux) / fish (macOS); `npm ci` → `check` → `build` → `test:e2e` |
| `src/core/paths.ts` | `paths()` and `ensureHome()` |
| `src/core/config.ts` | `Config` type, defaults, file loading/validation, `config get/set` logic |
| `src/core/logger.ts` | `logError()` with rotation, `readRecentErrors()` |
| `src/core/budget.ts` | `withBudget()` |
| `src/cli/index.ts` | Commander program (`--version`, `--help`) with a global error handler; later tasks register commands here |
| `tests/core/paths.test.ts` | 5 tests for paths |
| `tests/core/config.test.ts` | 16 tests for config |
| `tests/core/logger.test.ts` | 8 tests for the logger |
| `tests/core/budget.test.ts` | 5 tests for `withBudget` |
| `docs/reports/task-01.md` | This report |
| `docs/reports/task-00-plan-review.md` | §10 backfilled with Task 00's commit (B11) |
| `docs/PROGRESS.md` | Task 0 hash backfilled, Task 1 marked done |

Installed versions (all inside the repo, `npm ls --depth=0`):

```
+-- @eslint/js@10.0.1
+-- @types/node@22.20.5
+-- commander@15.0.0          (runtime dependency)
+-- eslint@10.13.0
+-- prettier@3.9.10
+-- tsup@9.0.0
+-- typescript-eslint@8.72.0
+-- typescript@6.0.3
`-- vitest@5.0.5
```

`better-sqlite3` is not installed yet; Task 2 is the first task that uses it.

## 3. Interfaces produced

**`src/core/paths.ts`**

- `interface Paths { home; db; config; shellDir; shellLog; binDir; shim; logDir; logFile; tmp }` (all `string`, all absolute)
- `paths(): Paths` returns the paths under `$LEFTOFF_HOME`, or `~/.leftoff` when the variable is unset or empty. A relative `LEFTOFF_HOME` is resolved against the current working directory. `env` is re-read on every call. Used by every task.

  Layout: `db` = `leftoff.db`, `config` = `config.json`, `shellDir` = `shell/`, `shellLog` = `shell/shell.log`, `binDir` = `bin/`, `shim` = `bin/leftoff`, `logDir` = `logs/`, `logFile` = `logs/leftoff.log`, `tmp` = `tmp/`.
- `ensureHome(): void` creates `home`, `shell/`, `bin/`, `logs/`, `tmp/` and forces each one to mode `0700`. Used by Task 2 (DB), Task 4 (scripts), Task 13 (shim), Task 15 (setup).

**`src/core/config.ts`**

- `POLISH_PROVIDERS = ['claude-cli', 'codex-cli', 'ollama', 'anthropic', 'openai'] as const`, the provider names from §1.9. Used by Task 12 and Task 15.
- `type PolishProviderName` (one of the above) and `type PolishSetting = 'off' | 'auto' | PolishProviderName`.
- `interface Config`, the full R-B9 shape (see §4). Used everywhere from Task 4 on.
- `DEFAULT_CONFIG: Readonly<Config>`, the frozen defaults from Global Constraints.
- `loadConfig(): Config` returns a fresh copy of the defaults merged with valid values from `config.json`. It never throws.
- `saveConfig(c: Config): void` writes `config.json` atomically (temp file + rename) with mode `0600`, creating the home directory if needed. Used by Task 15 (`setup`, `config set`).
- `getConfigValue(key: string): unknown` reads one leaf key (`'autoBrief.gapHours'`) and throws `unknown key: <key>` otherwise. Used by Task 15 (`config get`).
- `setConfigValue(key: string, raw: string): Config` parses and validates one raw CLI string, **saves**, and returns the updated config. It throws with a readable message on bad input. Used by Task 15 (`config set`).

**`src/core/logger.ts`**

- `logError(scope: string, err: unknown): void` appends `<ISO time> [<scope>] <message or stack on one line>` to `logs/leftoff.log`. It never throws. Used by every task.
- `readRecentErrors(n: number): string[]` returns the last `n` log lines, oldest first, reading `leftoff.log.1` too when needed. Used by Task 15 (`doctor`).

**`src/core/budget.ts`**

- `withBudget<T>(p: Promise<T>, ms: number): Promise<T | undefined>` returns `undefined` if `p` hasn't settled within `ms`. A rejection inside the budget is passed through; one after the budget is swallowed. Used by Task 8 (ingest), Tasks 10/11 (resume/loops budgets), Task 13 (hooks), Task 14 (`brief --auto`).

**`src/cli/index.ts`** has no exports. It is the bundle entry point, and each later task registers its commands here.

## 4. How it works

### paths

```ts
export function paths(): Paths {
  const env = process.env.LEFTOFF_HOME;
  const home = env ? resolve(env) : join(homedir(), '.leftoff');
  ...
}

export function ensureHome(): void {
  const p = paths();
  for (const dir of [p.home, p.shellDir, p.binDir, p.logDir, p.tmp]) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    // mkdir leaves existing directories alone and is subject to the umask.
    chmodSync(dir, 0o700);
  }
}
```

`paths()` is a function, not a constant, so a test or child process that changes `LEFTOFF_HOME` sees the new location immediately. `ensureHome` calls `chmodSync` explicitly because `mkdirSync({ mode })` doesn't change a directory that already exists and is filtered by the umask. P4 requires `700` regardless.

### config

The validator is driven by one table of leaf keys and their kinds:

```ts
const FIELDS: Record<string, Kind> = {
  sessionGapMinutes: NUMBER,
  retentionDays: NUMBER,
  'autoBrief.enabled': BOOLEAN,
  'autoBrief.gapHours': NUMBER,
  ...
  'ignore.projects': { type: 'list' },
  'polish.provider': { type: 'enum', values: ['off', 'auto', ...POLISH_PROVIDERS] },
  'polish.enabled': { type: 'list', values: POLISH_PROVIDERS },
  'polish.ollamaModel': { type: 'nullableString' },
  ...
};
```

The same table serves two different inputs:

1. **Reading `config.json`** (`isValid`): values are already JSON-typed.
   - numbers must be finite and ≥ 0;
   - booleans must be booleans;
   - enum values must be in the list;
   - lists must be string arrays (with allowed values for `polish.enabled`);
   - nullable strings must be a string or `null`.
2. **`leftoff config set`** (`parseRaw`): values are raw strings.
   - numbers must match `^\d+(\.\d+)?$`;
   - booleans must be exactly `true` or `false`;
   - lists are comma-separated, items trimmed, `""` = `[]`;
   - nullable strings use `""` = `null`.

`loadConfig` starts from a `structuredClone` of the defaults and applies each value from the file:

```ts
for (const [top, value] of Object.entries(parsed)) {
  if (SECTIONS.has(top)) {
    if (!isPlainObject(value)) { logError('config', `invalid value for ${top} (expected an object), using defaults`); continue; }
    for (const [sub, subValue] of Object.entries(value)) applyFileValue(config, `${top}.${sub}`, subValue);
  } else {
    applyFileValue(config, top, value);
  }
}
```

`applyFileValue` logs and drops unknown keys (plan Step 4), and logs and ignores values of the wrong type, so that key keeps its default. One bad key never discards the rest of the file. An unreadable file (invalid JSON, or not an object) logs one line and returns the defaults.

`setConfigValue` = parse raw → `loadConfig()` → set → `saveConfig()` → return. `saveConfig` writes `config.json.tmp-<pid>` with mode `0600`, then `rename`s it. A crash mid-write therefore never leaves a half-written `config.json`, and the final file has mode `0600` even if an older file had a looser mode, because the rename replaces it.

### logger

```ts
export function logError(scope: string, err: unknown): void {
  try {
    const { logDir, logFile } = paths();
    const message = describe(err).replace(/\s*\r?\n\s*/g, ' | ');
    const line = `${new Date().toISOString()} [${scope}] ${message}\n`;
    mkdirSync(logDir, { recursive: true, mode: 0o700 });
    if (existsSync(logFile) && statSync(logFile).size + Buffer.byteLength(line) > MAX_BYTES) {
      renameSync(logFile, `${logFile}.1`);
    }
    appendFileSync(logFile, line, { mode: 0o600 });
  } catch {
    // Nowhere left to report this.
  }
}
```

- Stack traces are collapsed onto one line with ` | ` separators, so "one line = one error" holds for `readRecentErrors`.
- Rotation happens *before* the write that would cross 1 MB, so `leftoff.log` never exceeds 1 MB. `rename` over an existing `leftoff.log.1` replaces it, so there are never more than 2 files.
- Everything is inside `try/catch`, because the logger is what other error paths call (§1.11 "never break the workflow").

`readRecentErrors(n)` reads `leftoff.log`; if that has fewer than `n` lines, it prepends the lines from `leftoff.log.1`, then returns the last `n`.

### budget

```ts
export function withBudget<T>(p: Promise<T>, ms: number): Promise<T | undefined> {
  return new Promise<T | undefined>((resolve, reject) => {
    const timer = setTimeout(() => resolve(undefined), ms);
    p.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (err: unknown) => { clearTimeout(timer); reject(err); },
    );
  });
}
```

- Clearing the timer on settle means a finished hook process isn't kept alive by a pending 2-second timer.
- Because `p` always has a rejection handler attached, a rejection that arrives after the timeout never becomes an `unhandledRejection` (which would print to stderr or crash a hook).
- Ingest (Task 8) can tell a timeout (`undefined`) apart from a collector error (a rejection), and the plan needs both: `detail: 'timeout'` vs `error`.

### cli/index.ts

```ts
const program = new Command().name('leftoff').description(pkg.description).version(pkg.version);
// Commands are registered here by later tasks.
try {
  await program.parseAsync(process.argv);
} catch (err) {
  logError('cli', err);
  process.stderr.write(`leftoff: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exitCode = 1;
}
```

The version and description come from `package.json` through a JSON import, which tsup inlines into the bundle. The global handler logs the error, prints one line to stderr, and sets exit code 1. Hooks (Task 13) will have their own always-exit-0 wrapper.

## 5. Design decisions

| Decision | Alternatives | Why |
|---|---|---|
| `paths()` re-reads `LEFTOFF_HOME` on every call | Compute once at import | Tests and child processes change it; the cost is negligible |
| Empty `LEFTOFF_HOME` = unset | Treat `""` as the cwd | `LEFTOFF_HOME=` in a shell almost always means "not set" |
| `ensureHome` creates `shell/`, `bin/`, `logs/`, `tmp/` too | Only `home` | Every later writer can then assume they exist; all must be `700` (P4) |
| `setConfigValue` saves to disk | Return the config only and let the caller save | Its only caller is `config set`, which must persist; the plan's test (`.autoBrief.gapHours` on the return value) works either way |
| A bad value in the file only resets that key | Reject the whole file | One typo shouldn't silently reset all settings |
| Numbers must be ≥ 0; decimals allowed | Integers only | `gapHours 0` is used in Task 18's fresh-machine check; `0.5` hours is a reasonable gap. No setting means anything when negative |
| Config file written atomically (temp + rename) | Write in place | `setup` and `config set` can run concurrently with readers; no half-written JSON |
| `DEFAULT_CONFIG` is frozen and `loadConfig` returns a deep clone | Shared mutable object | A caller mutating its config can't corrupt the defaults (tested) |
| Logger collapses multi-line errors to one line | Multi-line entries with separators | Keeps `readRecentErrors(n)` = last n errors |
| `readRecentErrors` returns oldest first | Newest first | Reads like the log; doctor (Task 15) can reverse it if it prefers |
| `withBudget` passes rejections through | Turn rejections into `undefined` | Ingest must tell "timeout" apart from "error" (Task 8 contract) |
| `@types/node@^22` | Latest `@types/node` | Type-checks against the oldest supported Node (22.12), so APIs that only exist in 24/26 are caught at compile time |
| Extra strictness: `noUncheckedIndexedAccess`, `verbatimModuleSyntax`, `isolatedModules` | Plain `strict` | Catches unchecked array/record access (common in log parsing, Tasks 4–7); `verbatimModuleSyntax` and `isolatedModules` match how esbuild/tsup and Node type stripping compile one file at a time |
| `module`/`moduleResolution: NodeNext` | `ESNext` + `Bundler` | Child processes run the source with Node directly (R-A5), so resolution must match Node's |
| `tsup` banner adds the shebang; target `node22` | Shebang in the source file | Keeps the source plain; the bin file must start with `#!/usr/bin/env node` |
| `test:e2e` = `npm run build && vitest run --project e2e --passWithNoTests` | Add the script in Task 13 | The owner asked for CI `check` → `build` → `test:e2e` now; `--passWithNoTests` keeps it green until Task 13 adds the first e2e test |
| CI installs zsh+fish on Linux and only fish on macOS | `brew install zsh fish` | macOS runners already have `/bin/zsh` |
| Prettier: single quotes, 100 columns | Prettier defaults | Matches the plan's code samples (single quotes); 100 columns fits the longer test names |
| `.prettierignore` includes `package-lock.json` | Format it | npm rewrites it on every install; formatting it would only create churn |
| `package.json` `version` stays `0.0.1` | `0.1.0` or `1.0.0-dev` | Matches the published placeholder; the plan bumps it in Task 17 (beta) and Task 18 (1.0.0) |
| `description` and `license: MIT` added to `package.json` | Wait until Task 18 | `--help` prints the description (the one-line pitch from §1.1); MIT is P12. `files`, `repository` and `keywords` are left to Task 18 as the plan says |

## 6. Tests

**RED: the run before any implementation** (`npx vitest run --project unit tests/core`). All four files fail because the modules don't exist, which is the failure plan Step 3 expects:

```
 FAIL  |unit| tests/core/logger.test.ts [ tests/core/logger.test.ts ]
Error: Cannot find module '../../src/core/logger.ts' imported from /Users/apple/leftoff/tests/core/logger.test.ts
 FAIL  |unit| tests/core/paths.test.ts [ tests/core/paths.test.ts ]
Error: Cannot find module '../../src/core/paths.ts' imported from /Users/apple/leftoff/tests/core/paths.test.ts
 ...
 Test Files  4 failed (4)
      Tests  no tests
```

**Mutation checks.** A module-missing failure doesn't prove the assertions themselves can fail, so after GREEN I broke the code three times on purpose and restored it each time:

| Break | Test that caught it |
|---|---|
| Removed `chmodSync(dir, 0o700)` from `ensureHome` | `ensureHome tightens an existing home directory to 0700` |
| Disabled rotation (`> MAX_BYTES` → `> Infinity`) | `log rotates at 1 MB keeping 2 files` |
| Removed `clearTimeout` on success in `withBudget` | `withBudget clears its timer once the promise settles` |

**Tests and what each proves.** Tests marked *(plan)* are from the plan; the rest are additions covering behavior the plan text requires (Step 4, §1.11, R-B9).

`tests/core/paths.test.ts`

| Test | Proves |
|---|---|
| paths honor LEFTOFF_HOME *(plan)* | Every path in `Paths` sits at the agreed location under `LEFTOFF_HOME` |
| paths default to ~/.leftoff when LEFTOFF_HOME is unset or empty | The P4 default, including `LEFTOFF_HOME=""` |
| a relative LEFTOFF_HOME is made absolute | "all absolute" holds for relative values |
| ensureHome creates home and subdirectories with 0700 *(plan)* | All five directories are created with `700`. The test uses a not-yet-existing directory, because `mkdtemp` already creates `700` and would pass trivially |
| ensureHome tightens an existing home directory to 0700 | An existing `755` directory is fixed (P4) |

`tests/core/config.test.ts`

| Test | Proves |
|---|---|
| missing config file returns defaults *(plan)* | No file → defaults (45 / 4 / `off`) |
| loadConfig returns a copy | Mutating a loaded config, including nested arrays, never changes `DEFAULT_CONFIG` |
| corrupt config file falls back to defaults and logs *(plan)* | Invalid JSON → defaults, plus an error log line mentioning config |
| partial config file is merged over defaults | `{autoBrief:{gapHours:6}}` keeps `autoBrief.enabled: true` and the other defaults |
| unknown keys in the file are dropped with a log line | Plan Step 4 |
| a value of the wrong type in the file falls back to its default | Only the bad keys reset, other valid keys in the same file are kept, and each bad key is logged by name |
| setConfigValue validates types *(plan)* | `"6"` → 6; `"abc"` → error mentioning "number"; unknown key → "unknown key" |
| setConfigValue rejects negative numbers and accepts 0 | `-1` rejected, `0` accepted (Task 18 uses `gapHours 0`) |
| setConfigValue saves | The next `loadConfig()` sees the value |
| setConfigValue parses booleans strictly | `true`/`false` only; `yes` rejected |
| setConfigValue parses comma-separated lists; "" is empty *(plan, added in review)* | R-B9 list parsing with trimming |
| setConfigValue: nullable strings, "" means null | R-B9 |
| setConfigValue: polish.provider and polish.enabled only accept known names | Enum and allowed-list validation; `off` is a valid provider *setting* but not an *enabled provider* |
| setConfigValue refuses section keys | `autoBrief` (an object) can't be overwritten with a scalar |
| getConfigValue reads leaf keys and rejects unknown ones | `config get` contract |
| saveConfig writes JSON with mode 0600 *(plan, added in review)* | P4 file mode, and the content round-trips |

`tests/core/logger.test.ts`

| Test | Proves |
|---|---|
| logError appends one line with timestamp, scope and message | Line format `ISO [scope] message` |
| readRecentErrors returns the last n lines, oldest first | Order and count |
| a multi-line error (stack trace) is stored as a single line | One entry per error |
| readRecentErrors returns [] when there is no log yet | No throw on a missing file |
| log file is created with mode 0600 | P4 |
| log rotates at 1 MB keeping 2 files *(plan)* | About 2.5 MB of writes leaves exactly `leftoff.log` + `leftoff.log.1`, with the current file ≤ 1 MB |
| readRecentErrors also reads the rotated file when the current one is short | Doctor's "last 5 errors" survives a rotation |
| logError never throws, even when the log cannot be written | `LEFTOFF_HOME` pointing at a regular file doesn't throw (§1.11) |

`tests/core/budget.test.ts`

| Test | Proves |
|---|---|
| withBudget returns undefined after timeout *(plan)* | The timeout path |
| withBudget returns the value when the promise settles in time | The success path |
| withBudget passes a rejection through | Ingest can distinguish error from timeout |
| withBudget clears its timer once the promise settles | No dangling timer keeps a hook process alive (uses fake timers) |
| a rejection after the budget expired is swallowed, not unhandled | No `unhandledRejection` from a late failure |

**Final run** (`npm run check`):

```
> @leftoff-dev/cli@0.0.1 check
> tsc --noEmit && eslint . && prettier --check . && vitest run --project unit

Checking formatting...
All matched files use Prettier code style!

 RUN  v5.0.5 /Users/apple/leftoff

 Test Files  4 passed (4)
      Tests  34 passed (34)
   Duration  196ms
```

`tsc` and `eslint` printed nothing, meaning no errors or warnings.

**Build and e2e script** (what CI runs after `check`):

```
$ npx tsup
ESM dist/cli.js 2.76 KB
ESM ⚡️ Build success in 5ms
$ npm run test:e2e; echo $?      → 0   (no e2e files yet; --passWithNoTests)
$ node dist/cli.js --version     → 0.0.1
$ node dist/cli.js --help
Usage: leftoff [options]

Your agents say they're done. leftoff shows you what's actually left.

Options:
  -V, --version  output the version number
  -h, --help     display help for command
$ head -1 dist/cli.js            → #!/usr/bin/env node   (file mode -rwxr-xr-x)
```

## 7. Edge cases and failure handling

| Situation | Behavior |
|---|---|
| `config.json` missing | Defaults, nothing logged |
| `config.json` not valid JSON, or not an object | Defaults, one error logged |
| Unknown key in `config.json` | Dropped, logged by name; other keys still applied |
| Wrong type in `config.json` (e.g. `"soon"` for a number, `"gpt"` for provider) | That key keeps its default, logged by name; other keys still applied |
| A section is not an object (e.g. `"autoBrief": 5`) | That section keeps its defaults, logged |
| `config set` with a bad value / unknown key / section key | Throws a readable error; nothing is written |
| Crash while saving config | The temp file may remain; `config.json` is either the old or the new version, never half-written |
| Log directory missing | Created on the first `logError` |
| Log not writable (home is a file, disk full, permissions) | `logError` silently does nothing; the caller is unaffected |
| Two processes logging at once | `appendFileSync` with small single writes; lines don't interleave in practice. Two processes rotating at the same instant could lose one rotated generation; acceptable for an error log |
| `withBudget` timeout | Returns `undefined`; the underlying work keeps running in the background, since JavaScript can't cancel a promise. Callers that must not commit late results (ingest) check for `undefined` |
| Late rejection after a timeout | Swallowed; no unhandled rejection |
| Concurrent `setConfigValue` calls | Last writer wins: each is load → modify → atomic save. Acceptable for an interactive command |

## 8. Deviations from the plan

None in scope or behavior. Three clarifications where the plan was silent:

1. **More tests than the plan lists:** 34 instead of 9. The extras test behavior the plan requires (Step 4's dropped unknown keys, P4 modes, §1.11's never-throw logger, R-B9 parsing) but has no named test for. No features were added.
2. **`setConfigValue` also saves.** The plan's signature returns `Config` without saying whether it persists. See §5.
3. **`package.json` has `description` and `license`.** Not listed in Task 1 Step 1; see §5. I did not add `files`, `repository` or `keywords`, which are Task 18.

## 9. Open questions and risks

1. **npm `allowScripts` (npm 11.20).** `npm install` printed: `1 package has install scripts not yet covered by allowScripts: esbuild@0.28.2 (postinstall: node install.js)`. npm did not run esbuild's postinstall. The build works anyway, because esbuild uses its platform package `@esbuild/darwin-arm64`. Task 2 will hit the same mechanism for `better-sqlite3`. Its prebuilt binary loaded in my plan-review scratch test without any install script, so I expect no problem, but I'll check. If you prefer to approve esbuild explicitly, the command is `npm install-scripts approve esbuild`. I have not run it.
2. **CI is untested until you push.** The workflow was checked by reading only. Things to watch on the first push:
   - `apt-get install fish` on ubuntu-latest;
   - `brew install fish` time on macos;
   - Node 26 availability in `actions/setup-node@v4`.
3. **`test:e2e` builds even when there are no e2e tests.** That's about 1 s; harmless.
4. **For Task 15:** `doctor` needs a "config valid" check. Since `loadConfig` never throws, doctor will have to re-read the file and report the keys it rejected. A helper that returns those problems belongs in Task 15. I didn't add one now, to stay within Task 1's interface list.

## 10. Commit

To be filled in by Task 2's commit (B11). The commit message is `chore: scaffold project, paths, config, logger`.
