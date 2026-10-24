# Task 03: Event model, redaction, project resolution

## 1. Goal

From the plan (Task 3): complete the event model and the two pieces every collector depends on:

- **`makeEvent` / `dedupeKey`:** the only way collectors build events. `makeEvent` "redacts summary and data, truncates summary to 300 chars (ending `…`), shrinks data to ≤ 4096 bytes by dropping largest string fields first then setting `{ truncated: true }`".
- **`redact` / `redactDeep`:** secrets replaced with `[REDACTED]` **before storage** (P10, Review Focus 3), using the plan's pattern list plus the word-boundary rules from R-D6.
- **`resolveProject` / `isInsideLeftoffHome`:** project identity = git top-level, or the real path outside git (P5). Covers the unusual layouts from Review Focus 4, plus the recursion guard's "inside `LEFTOFF_HOME`" check (§1.9).
- **`normalizeCommand`:** collapses whitespace and strips leading `VAR=value`, used for open-problem matching in Task 9.

Folded into this commit at the owner's request:
1. **Reading events skips rows whose `data` JSON can't be parsed**, logs once per read, and never throws.
2. **Plan text:**
   - the integer rule for count config keys (Task 1);
   - `ON CONFLICT(dedupe_key) DO NOTHING` plus the unreadable-row rule (Task 2);
   - `forget` keeps read positions (§1.10, and the Task 15 test and Task 18 README notes).

CI for Task 2 (`5a475af`) was green on all 6 jobs (checked with `gh run view 40093314885`), which confirms the ExperimentalWarning fix on Node 22 and 24.

## 2. Files

| File | Purpose |
|---|---|
| `src/model/event.ts` | **Completed:** adds `EventInput`, `dedupeKey`, `makeEvent`, `normalizeCommand` to the Task 2 types |
| `src/model/redact.ts` | **New:** `redact`, `redactDeep` |
| `src/model/project.ts` | **New:** `resolveProject`, `isInsideLeftoffHome` |
| `tests/model/redact.test.ts` | 28 tests |
| `tests/model/event.test.ts` | 16 tests |
| `tests/model/project.test.ts` | 11 tests |
| `src/store/repo.ts` | **Changed (fold-in):** `toEvent` → `toEvents`, which skips and logs unreadable rows |
| `tests/store/repo.test.ts` | **Changed (fold-in):** 2 new tests |
| `docs/leftoff-implementation-plan.md` | **Changed (fold-in):** 6 lines (see §8) |
| `docs/reports/task-03.md` | This report |
| `docs/reports/task-02.md` | §10 backfilled with Task 2's commit and the owner's answers |
| `docs/PROGRESS.md` | Task 2 hash backfilled, Task 3 marked done |

## 3. Interfaces produced

**`src/model/event.ts`**

- `type EventInput = Omit<WorkEvent, 'summary' | 'data'> & { summary: string; data?: Record<string, unknown> }`: the plan's `makeEvent` parameter type, given a name.
- `makeEvent(input: EventInput): WorkEvent`:
  - redacts `summary` (`redact`) and `data` (`redactDeep`);
  - truncates `summary` to 300 characters, ending with `…`;
  - shrinks `data` to ≤ 4096 bytes of JSON;
  - `data` defaults to `{}`.

  Used by every collector (Tasks 4–7), notes (Task 10) and hooks (Task 13).
- `dedupeKey(...parts: (string | number)[]): string`: sha1 hex of the parts joined by `\u0000`. Used by Tasks 4–7, 10, 13.
- `normalizeCommand(cmd: string): string`: collapses whitespace, strips leading `VAR=value` assignments (quoted values included), and leaves a bare assignment unchanged. Used by Task 9 (`findOpenProblems`). The plan lists it in Task 3 without naming a file; it lives here because it is about events' commands.

**`src/model/redact.ts`**

- `redact(text: string): string`: replaces the secret part of every pattern from the plan with `[REDACTED]`. Idempotent. Used by `makeEvent`, and by Task 4's shell collector indirectly through it.
- `redactDeep<T>(value: T): T`: returns a redacted **deep copy** without mutating the input. Strings are passed through `redact`; any string under a **secret-named key** (`password`, `apiKey`, `GH_TOKEN`, …) is replaced entirely. Used by `makeEvent`.

**`src/model/project.ts`**

- `resolveProject(cwd: string): string` returns the git top-level (`git -C <cwd> rev-parse --show-toplevel`, timeout 500 ms), or the real path of `cwd`. Cached per process; never throws. Used by Tasks 4–7 (event project roots), 10, 11, 13, 14 (current project).
- `isInsideLeftoffHome(path: string): boolean` is true for `LEFTOFF_HOME` itself and anything under it, comparing real paths. Used by every collector to drop polish sessions (recursion guard, §1.9 / Review Focus 1).

**`src/store/repo.ts`** has no interface change: `eventsForProject` and `eventsSince` now skip unreadable rows instead of throwing.

## 4. How it works

### Redaction

The rules run in a fixed order over the text:

```ts
const RULES = [
  [/(-----BEGIN [A-Z ]*PRIVATE KEY-----)[\s\S]*?(-----END [A-Z ]*PRIVATE KEY-----)/g, `$1${R}$2`],
  [/(:\/\/[^\s:/@]+:)[^\s@/]+@/g, `$1${R}@`],                 // scheme://user:PASS@host
  [/\b(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi, `$1${R}`],
  [/\bAKIA[0-9A-Z]{16}\b/g, R],
  [/\bgh[pousr]_[A-Za-z0-9]{36,}/g, R],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}/g, R],
  [/\bsk-ant-[A-Za-z0-9_-]{20,}/g, R],
  [/\bsk-[A-Za-z0-9_-]{20,}/g, R],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}/g, R],
  [/\beyJ[\w-]+\.[\w-]+\.[\w-]+/g, R],                         // JWT
  [/("([^"]*)"\s*:\s*)"(?:[^"\\]|\\.)*"/g, …isSecretName(key) ? `${prefix}"${R}"` : whole],   // "password": "x"
  [/([A-Za-z_][A-Za-z0-9_.-]*)=("[^"]*"|'[^']*'|[^\s"'&]+)/g, …isSecretName(name) ? `${name}=${R}` : whole], // NAME=x, --name=x
  [/(--?[A-Za-z][A-Za-z0-9_-]*)(\s+)("[^"]*"|'[^']*'|[^\s"'-][^\s"']*)/g, …],                   // --name x
];
```

1. **Block and structured forms first** (PEM, URL credentials, Bearer), so the later rules see `[REDACTED]` instead of fragments.
2. **Bare token shapes** (AWS, GitHub, Anthropic/OpenAI-style, Slack, JWT). Each starts with `\b` (R-D6). Without it, `risk-assessment-for-the-quarter` would match `sk-…`; a mutation test confirms this.
3. **Name-based rules** (`"key": "value"`, `NAME=value`, `--name=value`, `--name value`). A callback asks `isSecretName(name)`:

```ts
const SECRET_SUBSTRING = /password|passwd|passphrase|secret|token|api[_-]?key/i;
const SECRET_SEGMENT = /(^|[^a-z])(pass|auth|authorization)([^a-z]|$)/i;
```

The plan's name pattern is `(pass(word)?|secret|token|api[_-]?key|auth)`. Applied as a plain substring, it would redact `--author="Tanmay Kumar"`, `passport`, `compass`, `bypass`. So `pass` and `auth` only count as a **whole name segment** (`GH_AUTH`, `--auth`, `Authorization`, `pass`). `password`, `passwd` and `passphrase` still match anywhere (`PGPASSWORD`), as do `secret`, `token` and `api_key`. Over-redaction only affects display, so the substring rules stay broad (`tokenizer=bert` gets redacted, which is harmless).

`redact` is idempotent: running it again on its own output changes nothing (tested). That matters because `makeEvent` may receive text a collector already redacted.

`redactDeep` walks objects and arrays and builds a new value. For each object entry it passes down whether the **key** is a secret name; strings under such a key become `[REDACTED]` no matter what they contain:

```ts
function walk(value: unknown, secretKey: boolean): unknown {
  if (typeof value === 'string') return secretKey ? R : redact(value);
  if (Array.isArray(value)) return value.map((item) => walk(item, secretKey));
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, walk(v, isSecretName(k))]));
  }
  return value;
}
```

This catches `{ password: "hunter2" }`, where the bare value `hunter2` has no shape any pattern could recognize.

### makeEvent

```ts
export function makeEvent(input: EventInput): WorkEvent {
  return {
    ...input,
    summary: truncate(redact(input.summary), MAX_SUMMARY_CHARS),
    data: shrink(redactDeep(input.data ?? {})),
  };
}
```

- **Redact, then truncate.** The other order could cut a secret in half, leaving a fragment the patterns no longer recognize (e.g. `ghp_abc…` with fewer than 36 characters).
- **`truncate`** counts code points (`Array.from`), so the 300-character limit never splits an emoji or other surrogate pair. Text longer than 300 becomes 299 characters + `…` = exactly 300.
- **`shrink`:** if the JSON is ≤ 4096 bytes (UTF-8 bytes, not characters), `data` is returned as is. Otherwise it adds `truncated: true` and repeatedly deletes the largest top-level string field until the JSON fits. If no string fields are left and it still doesn't fit, the result is `{ truncated: true }`:

```ts
const out: Record<string, unknown> = { ...data, truncated: true };
while (byteSize(out) > MAX_DATA_BYTES) {
  let largest: string | null = null;
  for (const [k, v] of Object.entries(out)) {
    if (typeof v !== 'string') continue;
    if (largest === null || byteSize(v) > byteSize(out[largest])) largest = k;
  }
  if (largest === null) return { truncated: true };
  delete out[largest];
}
```

Example from the tests: `{ exitCode: 1, cwd: '/p', output: 5000×'o', error: 3000×'e' }` becomes `{ exitCode: 1, cwd: '/p', error: 3000×'e', truncated: true }`. Only `output` is dropped, and the small fields survive.

### dedupeKey

```ts
return createHash('sha1').update(parts.join('\u0000')).digest('hex');
```

The test checks it against an independent computation with `printf 'claude\0/f.jsonl\00012\0000' | shasum -a 1` = `56315c881e890f536e0715035683f434a816186a`.

### normalizeCommand

```ts
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=("[^"]*"|'[^']*'|\S*)\s+/;
let s = cmd.replace(/\s+/g, ' ').trim();
while (ASSIGNMENT.test(s)) s = s.replace(ASSIGNMENT, '');
```

The assignment must be followed by whitespace and a further word, so `FOO=1` on its own stays `FOO=1`; that line *is* the command. Quoted values with spaces are handled: `BAR="a b" npm test` → `npm test`.

### resolveProject

```ts
try {
  const top = execFileSync('git', ['-C', cwd, 'rev-parse', '--show-toplevel'], {
    timeout: 500, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
  }).trim();
  root = real(top);
} catch (err) {
  if ((err as { signal?: string }).signal) logError('project', `git timed out in ${cwd}`);
  root = real(resolve(cwd));
}
cache.set(cwd, root);
```

- `execFileSync` with an argument array: no shell, so paths with spaces or quotes are safe. stderr is discarded, so git's "not a git repository" never reaches the user's terminal (important for hooks).
- **Outside git, or git not installed:** the real path of `cwd`, with symlinks resolved, so `~/link-to-app` and `~/app` are one project.
- **git timeout (500 ms):** logged (the only unexpected case), then the same fallback.
- `real(path)` resolves symlinks for the longest part of the path that exists and appends the rest. A deleted directory therefore still gets a stable, non-throwing answer.

Layouts covered by tests: subdirectory, no commits, detached HEAD, spaces, linked worktree, nested repo, missing directory.

### isInsideLeftoffHome

```ts
const home = real(paths().home);
const p = real(resolve(path));
return p === home || p.startsWith(home + sep);
```

Comparing real paths is what makes the recursion guard reliable on macOS. Polish runs with cwd `~/.leftoff/tmp`, and Claude Code may record that cwd with or without symlinks resolved. The `+ sep` keeps `~/.leftoff-other` from counting as inside `~/.leftoff`.

### Fold-in: unreadable event rows

```ts
function toEvents(rows: EventRow[]): WorkEvent[] {
  ...
  for (const row of rows) {
    let data: Record<string, unknown>;
    try { data = JSON.parse(row.data) as Record<string, unknown>; }
    catch { skipped.push(row.dedupe_key); continue; }
    events.push({ ... });
  }
  if (skipped.length > 0) {
    const shown = skipped.slice(0, 5).join(', ') + (skipped.length > 5 ? ', …' : '');
    logError('store', `skipped ${skipped.length} events with unreadable data: ${shown}`);
  }
  return events;
}
```

There is one log line per read call, no matter how many rows are bad, and it names at most 5 dedupe keys. The log can't flood, and you can still find the rows.

## 5. Design decisions

| Decision | Alternatives | Why |
|---|---|---|
| `pass` and `auth` only as name segments | Plain substrings, as in the plan's pattern | `--author="Name"` (every git command with an author), `passport`, `compass` would be redacted. `password`/`passwd`/`passphrase` still match inside names (`PGPASSWORD`). Tested both ways |
| `redactDeep` redacts values under secret-named keys | Only pattern-match string values | `{ password: "hunter2" }` would otherwise be stored in clear text |
| `redactDeep` returns a copy | Redact in place | Callers may reuse the input object; mutating it would be surprising |
| Rules ordered: blocks → tokens → names | One combined regex | Later rules see `[REDACTED]` rather than fragments; each rule stays readable and separately testable |
| PEM: keep the BEGIN/END markers, redact the body | Replace the whole block | "Replace the secret part" (plan); the markers show *what* was there, which helps when reading a brief |
| `--name value` doesn't take a value starting with `-` | Always take the next word | `--password -u root` (no value) must not swallow `-u` |
| Redact before truncating | Truncate first | Truncation can cut a token below its pattern's minimum length and leak a prefix |
| Truncate by code points | `String.length` | Never produce half an emoji (invalid UTF-16) |
| Data size in UTF-8 bytes | Characters | The limit is "4096 bytes serialized" (Global Constraints) |
| Shrink considers top-level string fields only | Walk nested strings | Collector data is flat in the plan (`{ exitCode, durationMs, cwd }`, `{ path }`, `{ error }`); nested data that is still too big falls back to `{ truncated: true }`, as the plan says |
| `truncated: true` added whenever something was dropped | Only when everything was dropped | Readers can tell that a field is missing on purpose |
| `normalizeCommand` keeps a bare assignment | Strip it to `''` | An empty string would make every bare assignment "the same command" in Task 9 |
| `normalizeCommand` in `event.ts` | `project.ts`, a new file | The plan names no file; no new file needed |
| Real paths everywhere in `project.ts` | Plain `resolve` | macOS `/tmp` and `/var` are symlinks; git and Claude Code may report either form |
| Linked worktree = its own project | Map worktrees to the main repo | `--show-toplevel` (P5) returns the worktree; each worktree has its own branch and uncommitted state, which is exactly what a brief is about |
| Log only git timeouts, not "not a repo" or "git missing" | Log everything | The other two are normal (non-git folders) and would flood the log |
| Unexported internal helpers (`isSecretName`, size constants) | Export them | Not in the plan's interface list; nothing else needs them yet |
| Unreadable rows: one log line per read, at most 5 keys named | One line per row | A corrupted batch can't flood the log |

## 6. Tests

**RED: before implementation** (`npx vitest run --project unit tests/model`). `event.ts` existed with types only, so its functions were missing. `redact.ts` and `project.ts` didn't exist:

```
   × dedupeKey is the sha1 hex of the parts joined by NUL 3ms
   × makeEvent passes identity fields through and defaults data to {} 0ms
   ... (all 16 event tests ×)
 FAIL  |unit| tests/model/project.test.ts
Error: Cannot find module '../../src/model/project.ts' imported from /Users/apple/leftoff/tests/model/project.test.ts
 FAIL  |unit| tests/model/redact.test.ts
Error: Cannot find module '../../src/model/redact.ts' imported from /Users/apple/leftoff/tests/model/redact.test.ts
```

**RED: fold-in, unreadable rows** (before the change, the read threw):

```
   × rows whose data JSON cannot be parsed are skipped and logged once per read 5ms
SyntaxError: Expected property name or '}' in JSON at position 1 (line 1 column 2)
      Tests  1 failed | 20 passed (21)
```

**Mutation checks** (code broken on purpose, then restored):

| Break | Test that caught it |
|---|---|
| No `\b` before `sk-` | `redact leaves "risk-assessment-for-the-quarter" unchanged` (R-D6) |
| `pass`/`auth` as plain substrings | `redact leaves "git commit --author=\"Tanmay Kumar\" -m wip" unchanged` |
| No key-based redaction in `redactDeep` | `redactDeep redacts string values whose key is a secret name`, `makeEvent redacts summary and data` |
| Bearer rule removed | `redacts curl -H "Authorization: Bearer …"`, `"Authorization: Bearer x" is handled by the Bearer rule …` (R-D6) |
| `shrink` drops the smallest string first | `makeEvent shrinks data … dropping the largest string fields first` |
| Truncation by UTF-16 units | `makeEvent counts characters … never splits an emoji` |
| `normalizeCommand` strips only one assignment | `normalizeCommand("FOO=1 BAR=\"a b\" npm test")` |
| `isInsideLeftoffHome` prefix check without separator | `isInsideLeftoffHome: a sibling with the same prefix is outside` |
| Home not resolved to its real path | `isInsideLeftoffHome: sees through symlinks` |
| Unreadable rows kept with `data = {}` | `rows whose data JSON cannot be parsed are skipped …` |

**Tests and what each proves.** *(plan)* = named in the plan.

`tests/model/redact.test.ts` (28)

| Test | Proves |
|---|---|
| redacts %s ×5 *(plan)* | The plan's exact cases: `GITHUB_TOKEN=ghp_…`, Bearer, `postgres://admin:hunter2@`, `--password hunter2`, `ANTHROPIC_API_KEY=sk-ant-…` |
| redacts aws key / github token / fine-grained pat / openai-style key / slack token / jwt | Every remaining token pattern in the plan's list |
| redacts --token=value / json password / PGPASSWORD / GH_AUTH / quoted secret | All assignment forms in the plan (`--token=value`, `"password": "value"`, `KEY=value`), plus segment matching and quoted values |
| redacts a PEM private key block, keeping the markers | Multi-line PEM |
| redact leaves ordinary commands alone *(plan)* | `git commit -m "fix token parsing"` unchanged |
| redact leaves %j unchanged ×5 | No false positives: `risk-assessment…` (R-D6), `--author=`, `passport-local`, `user@host`, URL query |
| "Authorization: Bearer x" is handled by the Bearer rule *(R-D6)* | Header name kept, token removed |
| redact is idempotent | Re-running changes nothing |
| redactDeep walks nested objects and arrays *(plan)* | Nested strings redacted; numbers, booleans, `null` untouched |
| redactDeep redacts string values whose key is a secret name | `password`, `apiKey` → `[REDACTED]`; `user` kept; non-string `tokens: 5` kept |
| redactDeep does not mutate its input | |

`tests/model/event.test.ts` (16)

| Test | Proves |
|---|---|
| dedupeKey is the sha1 hex of the parts joined by NUL | Exact algorithm, against an independent `shasum` value |
| dedupeKey keeps part boundaries | `("a","bc")` ≠ `("ab","c")` |
| makeEvent passes identity fields through and defaults data to {} | |
| makeEvent redacts summary and data | Pattern-based and key-based, in summary and data |
| makeEvent truncates summary to 300 chars ending with … *(plan)* | 301 → 299 + `…`; exactly 300 unchanged |
| makeEvent counts characters, not UTF-16 units … | Emoji safety |
| makeEvent shrinks data to ≤ 4096 bytes by dropping the largest string fields first *(plan)* | Largest dropped first, small fields kept, flag added, result ≤ 4096 bytes |
| makeEvent measures data in bytes | 2 × 3000 bytes of `é` (only 1500 characters each) triggers shrinking |
| makeEvent falls back to { truncated: true } … | No strings left to drop |
| makeEvent leaves small data untouched | No flag when nothing was dropped |
| normalizeCommand strips env assignments *(plan)* | `'  FOO=1  npm   test '` → `'npm test'` |
| normalizeCommand(%j) ×5 | Several and quoted assignments, assignment-like flags kept, bare assignment kept, tabs and newlines |

`tests/model/project.test.ts` (11). The git commands run with `GIT_CONFIG_GLOBAL=/dev/null` and `GIT_CONFIG_NOSYSTEM=1`, so your own git config (signing, hooks) can't affect them.

| Test | Proves |
|---|---|
| subdir of repo → repo root *(plan)* | |
| non-git folder → realpath *(plan)* | Through a symlink |
| repo with no commits *(plan)* | |
| detached HEAD *(plan)* | |
| path with spaces *(plan)* | |
| a linked worktree is its own project *(plan)* | |
| a nested repo resolves to the inner repo | Review Focus 4 |
| a missing directory does not throw | |
| isInsideLeftoffHome: the home itself and paths under it | Including a not-yet-created path |
| isInsideLeftoffHome: a sibling with the same prefix is outside | |
| isInsideLeftoffHome: sees through symlinks | Symlinked `LEFTOFF_HOME` |

`tests/store/repo.test.ts` (fold-in, 2)

| Test | Proves |
|---|---|
| rows whose data JSON cannot be parsed are skipped and logged once per read | 2 bad rows + 1 good: good row returned; exactly 1 log line per read (`skipped 2 events … bad-1`) for both `eventsForProject` and `eventsSince` |
| a read with only valid rows logs nothing | No noise in the normal case |

**Final run** (`npm run check`):

```
> tsc --noEmit && eslint . && prettier --check . && vitest run --project unit

Checking formatting...
All matched files use Prettier code style!

 Test Files  9 passed (9)
      Tests  126 passed (126)
   Duration  1.07s
```

126 = 69 (Tasks 1–2) + 2 (fold-in) + 55 (model).

## 7. Edge cases and failure handling

| Situation | Behavior |
|---|---|
| Secret inside a long summary near the 300-character cut | Redacted before truncation, so no partial token is stored |
| Secret in a field with an innocent value shape (`{ password: "hunter2" }`) | Redacted by key |
| Secret with no recognizable shape and an innocent key (e.g. a password typed as a plain argument: `mysql -phunter2`) | **Not redacted.** No pattern can know. See §9 |
| Very large `data` (e.g. 1 MB of tool output) | Largest strings dropped until ≤ 4096 bytes; `truncated: true` |
| Large non-string data | `{ truncated: true }` |
| `cwd` not a git repo / git missing / cwd deleted | Real path (or resolved path) of `cwd`; no throw, no log |
| git hangs (network filesystem, huge repo) | Gives up after 500 ms, logs once, falls back to the real path |
| git prints warnings to stderr | Discarded; nothing reaches the terminal or a hook's output |
| Same `cwd` resolved repeatedly | Cached: one git call per directory per process |
| Repo created *after* a directory was resolved in the same process | The stale cached answer is kept for that process. Fine for short CLI and hook processes |
| Event row with corrupt `data` JSON | Skipped, one log line per read, no throw |

## 8. Deviations from the plan

1. **`pass` and `auth` match only as whole name segments.** The plan's pattern `(pass(word)?|secret|token|api[_-]?key|auth)` is still fully covered: everything it was meant to catch is caught, and tests show it, including `PGPASSWORD`, `GH_AUTH` and `Authorization`. The change avoids redacting `--author`, `passport` and similar. Same spirit as R-D6, but you didn't explicitly approve this; please confirm.
2. **`redactDeep` also redacts by key name.** The plan says only "walks nested objects". Without it, a secret stored as a plain value under `password` would be kept. This is stricter than the plan, never weaker.
3. **Plan text changes in this commit** (owner-requested), in `docs/leftoff-implementation-plan.md`:
   - Task 1 config paragraph: the integer rule for the four count keys;
   - Task 2 `insertEvents`: `ON CONFLICT(dedupe_key) DO NOTHING`, all-or-nothing;
   - Task 2 `eventsForProject` / `eventsSince`: unreadable rows skipped, one log line per read;
   - §1.10 `forget`: what it deletes, and that read positions are kept;
   - Task 15 tests: `forget` output and `--help` state that read positions are kept;
   - Task 18 README privacy section: the same note.

## 9. Open questions and risks

1. **Unshaped secrets are not caught.** `mysql -phunter2` (password glued to the flag), `sshpass -p hunter2` (single-letter flag), or a password pasted as a bare argument have nothing to recognize. The P10 safeguard for these is the leading-space rule (Task 4: commands typed with a leading space are never recorded), plus `ignore.commands`. Worth stating in the README (Task 18). I could add `-p<value>` for `mysql`/`mariadb` specifically if you want; I didn't, because it's outside the plan's list.
2. **Over-redaction is accepted.** Names containing `token`/`secret`/`password` (e.g. `--tokenizer=bert`, `SECRET_SANTA=1`) get their values hidden. Harmless, but you may see `[REDACTED]` in briefs for non-secrets.
3. **The `resolveProject` cache lives for the whole process.** Every leftoff process is short-lived (CLI command, hook), so stale entries don't matter today. If a long-running process ever appears, the cache needs an expiry.
4. **Please confirm deviation §8.1** (segment matching for `pass`/`auth`).

## 10. Commit

Commit `017b1d1`, message `feat(model): events, redaction, project resolution`.

```
$ git show --stat --format='%h %s' 017b1d1
017b1d1 feat(model): events, redaction, project resolution

 docs/PROGRESS.md                    |   6 +-
 docs/leftoff-implementation-plan.md |  11 +-
 docs/reports/task-02.md             |  31 ++-
 docs/reports/task-03.md             | 389 ++++++++++++++++++++++++++++++++++++
 src/model/event.ts                  |  64 +++++-
 src/model/project.ts                |  47 +++++
 src/model/redact.ts                 |  68 +++++++
 src/store/repo.ts                   |  45 +++--
 tests/model/event.test.ts           | 100 +++++++++
 tests/model/project.test.ts         | 119 +++++++++++
 tests/model/redact.test.ts          |  89 +++++++++
 tests/store/repo.test.ts            |  25 +++
 12 files changed, 971 insertions(+), 23 deletions(-)
```

Owner's answers to §9:
1. Add mysql/mariadb/mysqldump `-p<value>` and `sshpass -p <value>` rules (done in Task 4), plus the README leading-space note in the plan.
2. Over-redaction accepted.
3. Process-lifetime cache accepted.
4. Confirmed: `pass`/`auth` as whole name segments, and `redactDeep` redacting by key.
