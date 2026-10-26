# Task 04: Shell hook scripts and shell collector

## 1. Goal

From the plan (Task 4): capture terminal commands with **pure-shell hooks** (no Node process per command, < 5 ms per command, §1.4/§1.12), and turn them into events:

- **Hook scripts** `shell/leftoff.{zsh,bash,fish}`: append one tab-separated line per command to `shell.log`: `ts_epoch_ms \t exit_code \t duration_ms \t pid \t cwd \t command`. They skip leading-space commands, `LEFTOFF_INTERNAL=1`, and a missing log directory. They never print, and the file is created with `umask 077`. bash must work on **bash 3.2**. Timing follows R-B7.
- **Collector interface** (`Collector`, `CollectContext`, `CollectResult`), including the optional `afterCommit` (R-B5).
- **Shell collector:**
  - rotates `shell.log` by rename (R-B6);
  - reads complete lines only and emits `command` / `command_failed`;
  - redacts;
  - drops ignored projects, ignored commands and commands run inside `LEFTOFF_HOME`;
  - deletes processed files after commit.
- **rc installer:** `installShellScripts` copies the scripts to `~/.leftoff/shell/` with a version header (R-B8). `installShellHook` / `removeShellHook` add or remove the `# >>> leftoff >>>` block, with a `[ -r … ]` guard.

Folded into this commit at the owner's request:
1. Redaction of `mysql`/`mariadb`/`mysqldump` `-p<value>` and `sshpass -p <value>`, without touching `-p` in other commands.
2. Plan text: those rules in Task 3's pattern list; the Task 3 `pass`/`auth` segment decision and `redactDeep` key rule; and in Task 18's README plan, "commands typed with a leading space are never recorded — use that for anything sensitive".

## 2. Files

| File | Purpose |
|---|---|
| `shell/leftoff.zsh` | zsh hook: `preexec` stores command, start time and cwd; `precmd` appends the line |
| `shell/leftoff.bash` | bash hook (bash 3.2-safe): `PROMPT_COMMAND` function using `history 1` |
| `shell/leftoff.fish` | fish hook: `fish_preexec` / `fish_postexec` event handlers. **Not run locally** (see §9) |
| `src/collectors/types.ts` | `CollectContext`, `CollectResult`, `Collector` |
| `src/collectors/shell.ts` | `shellCollector` |
| `src/install/shell-rc.ts` | `installShellScripts`, `installedShellScriptVersion`, `installShellHook`, `removeShellHook`, `ShellName` |
| `tests/collectors/shell.test.ts` | 24 collector tests |
| `tests/shell/hooks.test.ts` | 27 tests that drive **real interactive zsh, bash and fish** (fish: 6 skipped locally) |
| `tests/shell/run-shell.ts` | Test helper: runs an interactive shell fed from stdin, like a user typing |
| `tests/install/shell-rc.test.ts` | 12 installer tests, including an end-to-end real zsh with a temp `.zshrc` |
| `tests/fixtures/shell/basic.log` | Byte-exact fixture: 4 valid lines (success, failure, exit 127, secret, bash `-1` duration) + 1 malformed |
| `src/model/redact.ts` | **Changed (fold-in):** two command-specific rules |
| `tests/model/redact.test.ts` | **Changed (fold-in):** 13 new tests |
| `docs/leftoff-implementation-plan.md` | **Changed (fold-in):** Task 3 pattern list, Task 18 README note |
| `docs/reports/task-04.md` | This report |
| `docs/reports/task-03.md` | §10 backfilled with Task 3's commit and the owner's answers |
| `docs/PROGRESS.md` | Task 3 hash backfilled, Task 4 marked done |

## 3. Interfaces produced

**`src/collectors/types.ts`** (used by Tasks 5–8 and future collectors)

- `interface CollectContext { repo: Repo; config: Config; now: Date; projectFilter?: string }`
- `interface CollectResult { events: WorkEvent[]; pendingCursors: { key: string; value: string }[]; warnings: string[] }`
- `interface Collector { name: Source; isAvailable(ctx): Promise<boolean>; collect(ctx): Promise<CollectResult>; afterCommit?(ctx): Promise<void> }`. Collectors only read cursors; ingest (Task 8) commits events and `pendingCursors` in one transaction, then calls `afterCommit`.

**`src/collectors/shell.ts`**

- `shellCollector: Collector`:
  - `name`: `'shell'`;
  - `isAvailable`: true when `~/.leftoff/shell/` exists;
  - `collect`: rotates and reads, see §4;
  - `afterCommit`: deletes fully committed `*.ingesting` files.
  - **Cursor:** one row, `('shell', 'ingesting')`, whose value is JSON `{ "<file name>": <committed byte offset> }` (see §8.1).
  - **Warnings:** `malformed:<count>:<file>` (R-B10 format).

  Used by Task 8 (`collectors()` registry, ingest).

**`src/install/shell-rc.ts`** (used by Task 15 `setup` / `uninstall` / `doctor`)

- `type ShellName = 'zsh' | 'bash' | 'fish'`
- `installShellScripts(packageShellDir: string, version: string): void` copies the three scripts to `paths().shellDir` with first line `# leftoff <version>`, mode `0600`, overwriting older copies.
- `installedShellScriptVersion(shell: ShellName): string | null` returns the version from that header, or `null` if the script isn't installed.
- `installShellHook(shell: ShellName, rcPath: string, scriptPath: string): 'installed' | 'already'` appends the guarded block (or replaces it if the script path changed), creating the rc file and its directory if needed.
- `removeShellHook(rcPath: string): boolean` removes the block and the blank line added before it; `false` if there was no block.

**Shell scripts** (sourced from rc files; used by `setup` in Task 15 and extended in Task 14):

- `__leftoff_auto`: a no-op stub in all three shells, which Task 14 fills in (plan Task 4).
- Internal names: `__leftoff_preexec` / `__leftoff_precmd` (zsh), `__leftoff_prompt` (bash), `__leftoff_preexec` / `__leftoff_postexec` (fish).

## 4. How it works

### Capture: zsh

```zsh
[[ -o interactive ]] || return 0
zmodload zsh/datetime 2>/dev/null || return 0
autoload -Uz add-zsh-hook

__leftoff_preexec() {
  __leftoff_cmd=$1 # the line as typed, including a leading space
  __leftoff_start=$EPOCHREALTIME
  __leftoff_cwd=$PWD
}

__leftoff_precmd() {
  local exit_code=$? cmd=$__leftoff_cmd
  __leftoff_cmd=
  [[ -n $cmd && $cmd != ' '* && $LEFTOFF_INTERNAL != 1 ]] || return 0
  local log=${LEFTOFF_HOME:-$HOME/.leftoff}/shell/shell.log
  [[ -d ${log:h} ]] || return 0
  local now=$EPOCHREALTIME
  local -i ts=$(( now * 1000 )) duration=$(( (now - __leftoff_start) * 1000 ))
  local cwd=${__leftoff_cwd//[$'\t\r\n']/ }
  cmd=${cmd//$'\\\n'/ } # line continuations, joined as the shell joins them
  cmd=${cmd//[$'\t\r\n']/ }
  [[ -e $log ]] || (umask 077 && : >>$log) 2>/dev/null
  print -rn -- "$ts"$'\t'"$exit_code"$'\t'"$duration"$'\t'"$$"$'\t'"$cwd"$'\t'"$cmd"$'\n' >>$log 2>/dev/null
  return 0
}
add-zsh-hook preexec __leftoff_preexec
add-zsh-hook precmd __leftoff_precmd
```

Facts I checked with real zsh 5.9 before writing this (probe results in §6):
- `preexec`'s `$1` is the line exactly as typed, **including a leading space**, so the leading-space check works without depending on `HIST_IGNORE_SPACE`.
- zsh restores `$?` for **every** precmd function, so our position in `precmd_functions` doesn't matter, and `add-zsh-hook` (which appends and never duplicates) is safe.
- The cwd recorded is the directory where the command **started** (`cd sub` is recorded with the old directory).

On cost: the `umask` subshell forks only once, when the log file doesn't exist yet. Every other command is pure builtins: about **0.09 ms per command** measured over 200 commands.

### Capture: bash (3.2-safe)

```bash
__leftoff_prompt() {
  local exit_code=$? line num cmd log ts cwd
  line=$(HISTTIMEFORMAT= builtin history 1 2>/dev/null)
  line=${line#"${line%%[![:space:]]*}"} # "  42  make" -> "42  make"
  num=${line%%[[:space:]]*}
  if [ -z "$__leftoff_ready" ]; then
    __leftoff_ready=1                    # first prompt: newest entry predates this hook
    __leftoff_hist=$num
    return $exit_code
  fi
  if [ -z "$num" ] || [ "$num" = "$__leftoff_hist" ]; then return $exit_code; fi
  __leftoff_hist=$num
  cmd=${line#"$num"}
  cmd=${cmd#  }                          # history prints two spaces after the number
  case $cmd in '' | ' '*) return $exit_code ;; esac
  ...
  if [ -n "${EPOCHREALTIME:-}" ]; then   # bash >= 5: microseconds -> milliseconds
    ts=${EPOCHREALTIME/[.,]/}; ts=${ts%???}
  else
    ts=$(date +%s)000
  fi
  ...
  printf '%s\t%s\t%s\t%s\t%s\t%s\n' "$ts" "$exit_code" -1 "$$" "$cwd" "$cmd" >>"$log" 2>/dev/null
  return $exit_code
}
case ";${PROMPT_COMMAND:-};" in
  *";__leftoff_prompt;"*) ;;
  *) PROMPT_COMMAND="__leftoff_prompt${PROMPT_COMMAND:+;$PROMPT_COMMAND}" ;;
esac
```

How each requirement is met:
- **First prompt:** the newest history entry belongs to a previous session (loaded from `HISTFILE`), so the first prompt only remembers its number.
- **A command ran** only if the history number changed. An empty line, or a command kept out of history (`ignorespace`), changes nothing.
- **Leading space:** `history 1` keeps it (checked with real bash 3.2: `    3   echo spaced`).
- **`return $exit_code`:** the user's own `PROMPT_COMMAND`, which runs after ours, still sees the real `$?` (tested).
- **bash 3.2 compatibility:** no arrays, no `PS0`, no `${var,,}`; `$'…'` quoting and `${var//…}` exist in 3.2. `PROMPT_COMMAND` is prepended as a string, and re-sourcing doesn't add it twice.
- **Timestamp:** bash ≥ 5 reads `$EPOCHREALTIME` (works with either decimal separator); bash < 5 forks `date +%s` once per command (second resolution).
- **Duration:** always `-1`. See §8.2.
- **Cost:** about **3.0 ms per command** on bash 3.2. That figure includes the test loop's own `history -s`; the hook itself forks twice, for `$(history 1)` and `$(date …)`. Under the 5 ms budget, but closer to it; see §9.

### Capture: fish

The script defines `fish_preexec` (remembers `$PWD`) and `fish_postexec` handlers. `$status` is read first, and the duration comes from `$CMD_DURATION` (`-1` if missing). Timestamps are `(date +%s)000`, because fish has no millisecond clock. The pid is `$fish_pid`. If the log file doesn't exist, it's created with `touch` + `chmod 600`, because `umask` in fish would change the whole shell's umask. Everything is inside `if status is-interactive`.

### Collect: rotation and reading

```ts
const files = listIngesting(shellDir);                    // leftovers from earlier runs, oldest first
if (existsSync(shellLog) && statSync(shellLog).size > 0) {
  const name = `shell.log.${Date.now()}.${process.pid}.ingesting`;
  renameSync(shellLog, join(shellDir, name));             // shells now append to a fresh shell.log
  files.push(name);
}
const committed = readOffsets(ctx.repo.getCursor('shell', CURSOR_KEY));
for (const name of files) {
  const chunk = readChunk(file, committed[name] ?? 0, ctx.config.ingest.maxBytesPerFilePerRun);
  for (const raw of chunk.text.split('\n')) { ...parse, filter, toEvent... }
  ...
  next[name] = offset;
}
result.pendingCursors.push({ key: CURSOR_KEY, value: JSON.stringify(next) });
```

- `readChunk` reads from the committed offset, at most `maxBytesPerFilePerRun`. It returns only the text up to the **last newline**, so a partial last line is never consumed.
- **Filters**, applied in this order:
  1. unparseable line → counted as `malformed`;
  2. command starting with a space → dropped (the hooks already skip these; this is a second safeguard);
  3. cwd inside `LEFTOFF_HOME` → dropped (recursion guard, §1.9);
  4. cwd, or any folder above it, matches `ignore.projects` → dropped;
  5. normalized command matches `ignore.commands` → dropped.
- **Event:**
  - `kind` = `command` (exit 0) or `command_failed`;
  - `summary` = the command, or `` `cmd` exited N `` on failure;
  - `sessionRef` = `shell:<pid>`, `ts` = ISO from the millisecond timestamp;
  - `data` = `{ exitCode, durationMs (null for -1), cwd }`;
  - `projectRoot` = `resolveProject(cwd)`; `dedupeKey` = `dedupeKey('shell', <raw line>)`.

  Everything passes through `makeEvent`, so it is redacted and size-limited.
- **Two edge rules** keep a file from blocking forever:
  1. If the read reached the end, a partial line is left over, and nobody has written to the file for 60 s, that line can never be finished. It's counted as malformed and consumed.
  2. If a single "line" is longer than the per-run cap, that chunk is skipped as malformed.

### afterCommit: deleting what was committed

```ts
for (const [name, offset] of Object.entries(readOffsets(ctx.repo.getCursor('shell', CURSOR_KEY)))) {
  try { if (statSync(file).size === offset) unlinkSync(file); } catch { /* already gone */ }
}
```

A renamed file is deleted only when **every byte** of it is committed. If a shell opened `shell.log` just before the rename and wrote its line just after, the line went into the renamed file. That file then has unread bytes, so it is kept and the line is read on the next run (tested). This closes the race I flagged in the plan review (B6).

### Glob matching for `ignore.*`

The plan allows no extra dependencies, so a small glob-to-regex converter handles `*`, `**` and `?`, plus a leading `~`:
- **Project globs:** `*` doesn't cross `/`. A folder is ignored if it **or any parent** matches, so `~/secret` ignores everything under it.
- **Command globs:** `*` matches anything (commands contain `/`), checked against `normalizeCommand(cmd)`. `vault *` drops `vault read secret/db`; `pass` drops only the exact command `pass`.

### rc installer

```ts
function block(shell: ShellName, scriptPath: string): string {
  const q = quote(shell, scriptPath);
  const source = shell === 'fish' ? `test -r ${q}; and source ${q}` : `[ -r ${q} ] && . ${q}`;
  return `${BEGIN}\n${source}\n${END}\n`;
}
```

Example block in `~/.zshrc` (R-B8):

```
# >>> leftoff >>>
[ -r "/Users/you/.leftoff/shell/leftoff.zsh" ] && . "/Users/you/.leftoff/shell/leftoff.zsh"
# <<< leftoff <<<
```

- The path is double-quoted with shell-specific escaping, so paths with spaces, quotes or `$` work.
- **Install** appends a blank line plus the block; if the block exists with a different path, it's replaced in place.
- **Remove** deletes the block and that blank line. Install followed by remove restores the original file byte for byte (tested).
- Files are written **in place**, not via temp file + rename, so a `~/.zshrc` that is a symlink into a dotfiles repo stays a symlink (tested).

### Fold-in: mysql and sshpass passwords

```ts
[/(\b(?:mysql|mariadb|mysqldump)\b[^\n|;&]*?\s-p)\S+/g, `$1${R}`],
[/(\bsshpass\b[^\n|;&]*?\s-p\s*)\S+/g, `$1${R}`],
```

- A rule only applies after its command word, within the same command: it stops at `|`, `;` and `&`, so `cd mysql-data && ls -p` is untouched.
- mysql only redacts a **glued** value (`-pSECRET`); a bare `-p` prompts for the password and stays.
- `-P 3306` (capital, the port) is untouched.

## 5. Design decisions

| Decision | Alternatives | Why |
|---|---|---|
| Tests drive **real interactive shells** fed from stdin | Call the hook functions directly (plan's "simpler" suggestion) | I checked that `zsh -fi` / `bash -i` fed from stdin run the real `preexec`/`precmd`/`PROMPT_COMMAND`. This tests what users actually run: hook registration, `$?` handling, history numbering |
| zsh: `add-zsh-hook` (append) | Put ours first in `precmd_functions` | zsh restores `$?` for each hook (probed); `add-zsh-hook` is the standard way and never duplicates |
| zsh: join `\`-newline continuations | Keep them | The shell itself removes them; a multi-line command then normalizes the same as its one-line retry (open-problem matching, Task 9) |
| bash: skip the first prompt | Record it | Its newest history entry is from a previous session (or the `source` line) |
| bash: only record when the history number changes | Compare command text | An empty line or `ignorespace` produce no new entry, so nothing is recorded; same text run twice is still recorded twice |
| bash: `return $exit_code` | `return 0` | Prompt themes and other `PROMPT_COMMAND`s rely on `$?` (tested) |
| bash: `--noediting` in tests | Readline on | Readline treats a typed tab as completion; real users can't type a raw tab either, but the test needs one to prove tabs are removed |
| Log file created once with mode 600 (`umask 077` in a subshell; fish: `touch` + `chmod`) | `umask` around every write | One fork in the file's lifetime instead of one per command |
| One cursor row `('shell','ingesting')` with a JSON map | One cursor row per `*.ingesting` file (plan text) | File names are unique per run and `Repo` has no `deleteCursor`, so per-file rows would pile up forever (one per ingest with shell activity). The map only ever contains files that still exist. See §8.1 |
| File name `shell.log.<ms>.<pid>.ingesting` | `shell.log.<pid>.ingesting` (plan text) | Unique even if a pid is reused; sorting by name processes leftovers oldest first |
| Dedupe key = sha1 of the raw line | File + offset | Stable however the file is renamed, re-read or split across runs |
| `afterCommit` deletes only fully committed files | Delete after every commit | Prevents losing a line written into the renamed file after we read it (race found in the plan review) |
| Partial line older than 60 s is dropped as malformed | Keep forever; append back to `shell.log` | Appending a partial line to a live file could glue it onto a shell's next line. 60 s without a write means no shell will finish it |
| Ignore a folder if it or any parent matches | Exact match only | `ignore.projects ~/secret` is what users will type; it should cover everything inside |
| Glob converter written by hand | `path.matchesGlob` (Node 22.5+, experimental) | Experimental APIs can print warnings to stderr, which hooks must never do; no new dependency allowed |
| rc written in place | Temp file + rename | Keeps symlinked dotfiles intact |
| Script copy overwritten on every install | Only when the version differs | Simple; `setup` re-runs refresh it (R-B8) |

## 6. Tests

**Probes before writing the scripts** (real zsh 5.9 and /bin/bash 3.2 fed from stdin):

```
zsh:  p1 sees ?=1 / p2 sees ?=1                → $? restored for every precmd function
zsh:  preexec 1=[ echo spaced] 2=[echo spaced] → $1 keeps the leading space
bash: PC ?=1 hist=[    2  false]               → PROMPT_COMMAND runs; "%5d  %s" history format
bash: PC ?=0 hist=[    3   echo spaced]        → leading space kept in history
bash: user PC sees ?=1                         → returning the saved code keeps $? for the user's PROMPT_COMMAND
```

Real log lines written by the finished hooks (temp path shortened to `<tmp>`):

```
1792846086479  0    0  76685  /Users/apple/leftoff  cd <tmp>/w     ← zsh: cwd where the command started
1792846086480  0    0  76685  <tmp>/w               echo hi
1792846086480  1    0  76685  <tmp>/w               false
1792846086590  0  109  76685  <tmp>/w               sleep 0.1      ← zsh: real duration
1792846086000  0   -1  76689  <tmp>/w               cd <tmp>/w     ← bash 3.2: second resolution, -1, cwd at next prompt
1792846086000  0   -1  76689  <tmp>/w               echo hi
1792846086000  1   -1  76689  <tmp>/w               false
1792846086000  0   -1  76689  <tmp>/w               sleep 0.1
```

The ` echo hidden` line (typed with a leading space) appears in neither shell's output.

**RED: before implementation** (`npx vitest run --project unit tests/collectors tests/shell tests/install`):

```
 FAIL  |unit| tests/collectors/shell.test.ts
Error: Cannot find module '../../src/collectors/shell.ts' imported from .../tests/collectors/shell.test.ts
 FAIL  |unit| tests/install/shell-rc.test.ts
Error: Cannot find module '../../src/install/shell-rc.ts' imported from .../tests/install/shell-rc.test.ts
 FAIL  |unit| tests/shell/hooks.test.ts > zsh hook > records successful and failing commands with exit code, pid and cwd
AssertionError: expected [] to include 'echo hi'
 ... (19 failed)
```

**RED: fold-in** (5 positive redaction cases failed before the rules were added):

```
   × redacts a glued or -p password: mysql -u root -phunter2 shop
   ...
      Tests  5 failed | 34 passed (39)
```

**Failures during GREEN that changed code:**
1. `a multi-line command is stored on one line`: zsh's `$1` keeps `\`-newline. Fixed by joining continuations.
2. While editing that fix, a JavaScript `String.replace` turned `$'` into "text after the match" and corrupted `leftoff.zsh` (9 tests failed). I rewrote the file from scratch instead of patching it.

**Mutation checks** (code broken on purpose, then restored):

| Break | Caught by |
|---|---|
| `afterCommit` deletes files with unread bytes | 4 tests (partial line kept, late line not lost, byte cap, long line) |
| Ignore check looks only at the exact folder | `ignored project globs are dropped (the folder and everything under it)` |
| `-1` duration stored as `-1` | `duration -1 (bash) is stored as durationMs null` |
| No `LEFTOFF_HOME` filter | `commands run inside LEFTOFF_HOME are dropped` |
| rc block without `[ -r ]` guard | 2 tests (block text; real zsh sourcing a missing script prints nothing) |
| zsh records leading-space commands | `a command typed with a leading space is not recorded` |
| zsh keeps tabs | `a real tab in a command becomes a space …` **(survived at first; see below)** |
| bash keeps tabs | same test (bash) |
| bash records the previous session's command | `the first prompt does not record the previous session's last command` |
| bash returns 0 instead of the saved code | `the existing PROMPT_COMMAND is kept and still sees the real exit code` |
| bash / zsh register the hook twice on re-source | `re-sourcing the hook does not register it twice` **(survived at first; see below)** |
| Over-long-line skip removed | `a single line longer than maxBytesPerFilePerRun is skipped instead of stalling` (written after the code; shown failing without it) |
| Glued-`-p` rule not limited to mysql | `-p in other commands is untouched: "pg_dump -p5432 shop"`, `"tar -pxf backup.tar"` |

Two mutations survived the first round and exposed weak tests, which I then strengthened:
- **Tabs:** the test typed `printf 'a\tb\n'`, which is a backslash and a `t`, never a real tab. It now types a literal tab (bash runs with `--noediting` so readline doesn't eat it).
- **Double registration:** recording twice is prevented anyway by the history-number check, so counting log lines couldn't see it. The tests now check `$PROMPT_COMMAND` and `$precmd_functions` directly.

**Tests and what each proves**

`tests/collectors/shell.test.ts` (24)

| Test | Proves |
|---|---|
| parses complete lines and ignores a partial last line *(plan)* | Committed offset = byte length of the complete lines |
| maps a successful line to a command event | Every field: kind, projectRoot, ISO ts, `shell:<pid>`, summary, data |
| exit code != 0 becomes command_failed *(plan)* | Kind, `` `ls /nope` exited 1 `` summary |
| duration -1 (bash) is stored as durationMs null | R-B7 |
| redacts secrets in commands *(plan)* | |
| ignored project globs are dropped (the folder and everything under it) *(plan)* | |
| ignore.projects supports * and a leading ~ | `*` doesn't cross `/`; `**`; `~` expansion |
| ignored commands are dropped | `vault *` and exact `pass`; `passwd-check` kept |
| commands run inside LEFTOFF_HOME are dropped | Recursion guard |
| a leading-space command that reached the log anyway is dropped | Second safeguard |
| malformed lines are skipped and counted in warnings | Fixture file; `malformed:1:<file>` |
| re-reading without a commit yields the same events with the same dedupe keys | Ingest failure, then retry: no loss, no duplicates |
| after a commit the same lines are not read again | |
| lines appended after the rename land in the new shell.log and are read next run *(plan, R-B6)* | |
| afterCommit deletes a fully read ingesting file | |
| afterCommit keeps an ingesting file that still has a partial last line *(R-B6)* | |
| a late line written into the renamed file is read on the next run, not lost | The rename race |
| a leftover ingesting file from a crashed run is processed first | Order and cleanup |
| an abandoned partial line … is dropped and counted | 60 s rule |
| reads at most ingest.maxBytesPerFilePerRun per file and continues next run | §1.6 cap |
| a single line longer than maxBytesPerFilePerRun is skipped instead of stalling | No infinite stall |
| no shell.log → no events; missing shell dir → isAvailable false | |
| an empty shell.log is not rotated | No empty `*.ingesting` files |
| the rotated file keeps its content until afterCommit | |

`tests/shell/hooks.test.ts` (27: 21 run locally, 6 fish skipped). For each of zsh, bash and fish:

| Test | Proves |
|---|---|
| records successful and failing commands with exit code, pid and cwd *(plan)* | The line format, a timestamp within the run window (second resolution allowed), and the cwd |
| a command typed with a leading space is not recorded *(plan)* | |
| LEFTOFF_INTERNAL=1 records nothing | §1.9 |
| a missing log directory records nothing and prints nothing about it | Never prints (D10) |
| the log file is created with mode 0600 | `umask 077` |
| a real tab in a command becomes a space, so a line always has 6 fields | |

zsh details: duration in ms (`sleep 0.3` ≥ 250 ms); cwd where the command started; multi-line command on one line; re-sourcing registers once.
bash details: duration `-1`; existing `PROMPT_COMMAND` kept and sees the real exit code; first prompt skips the previous session; empty line doesn't re-record; re-sourcing registers once.

`tests/install/shell-rc.test.ts` (12)

| Test | Proves |
|---|---|
| installShellHook is idempotent and removable *(plan)* | |
| install then remove restores the original rc file byte for byte | |
| the block is appended after existing content, which is left untouched | Including a file without a trailing newline |
| removeShellHook returns false when there is no block or no file | |
| a missing rc file (and fish config dir) is created | |
| zsh/bash block sources the script behind a [ -r ] guard; fish uses test -r *(R-B8)* | |
| a changed script path replaces the block instead of adding a second one | |
| an rc file that is a symlink (dotfiles repo) stays a symlink | |
| sourcing the rc block when the script is missing prints nothing and succeeds *(R-B8)* | Real zsh, path with spaces |
| installShellScripts copies the scripts with a version header and mode 0600 *(R-B8)* | |
| installShellScripts overwrites older copies; version is null when not installed | |
| end to end: setup-style install into a temp ZDOTDIR records a command from a real zsh | Copy, rc block, real interactive zsh, log line |

`tests/model/redact.test.ts` (fold-in, 13 new)

| Test | Proves |
|---|---|
| redacts a glued or -p password ×5 | `mysql -phunter2`, `mariadb -pS3cr3t!`, `mysqldump -uroot -pabc123`, `sshpass -p hunter2`, `sshpass -phunter2` |
| -p in other commands is untouched ×8 | `mysql -P 3306 … -p` (prompt), `ssh -p 2222`, `docker run -p 3306:3306`, `mkdir -p`, `git log -p`, `cd mysql-data && ls -p`, `pg_dump -p5432`, `tar -pxf` |

**Final run** (`npm run check`):

```
> tsc --noEmit && eslint . && prettier --check . && vitest run --project unit

Checking formatting...
All matched files use Prettier code style!

 Test Files  12 passed (12)
      Tests  196 passed | 6 skipped (202)
   Duration  1.44s
```

196 = 126 (Tasks 1–3) + 13 (redaction fold-in) + 24 (collector) + 21 (hooks run locally) + 12 (installer). The 6 skipped are the fish hook tests; fish isn't installed here.

## 7. Edge cases and failure handling

| Situation | Behavior |
|---|---|
| Log directory missing (leftoff uninstalled or never set up) | Hooks return immediately, print nothing |
| Log file not writable / disk full | Write error discarded (`2>/dev/null`); the prompt is unaffected |
| Script file missing (deleted `~/.leftoff`) | rc block's `[ -r ]` guard skips it silently |
| Non-interactive shells (scripts, `zsh -c`) | Hooks don't load (`-o interactive` / `$-` / `status is-interactive`) |
| `LEFTOFF_INTERNAL=1` (polish subprocesses) | Nothing recorded |
| Leading-space command | Not recorded by any hook; also dropped by the collector if one gets through |
| Command with tabs, newlines, line continuations | Turned into spaces; always 6 fields |
| bash: `HISTCONTROL=ignoredups` and the same command twice in a row | Second run creates no history entry, so it's not recorded. Known limitation; harmless for briefs |
| bash: history disabled (`set +o history`) | Nothing recorded (no history numbers) |
| Several terminals writing at once | Each line is one small `>>` write (atomic append); lines don't interleave |
| A shell writes while ingest renames the file | Line lands in the renamed file; kept until read (tested) |
| Ingest crashes or times out after the rename | `*.ingesting` file stays and is processed first next run; cursor prevents duplicates |
| Two ingests at the same time | Both may read the same renamed file; dedupe keys make the second insert a no-op; `afterCommit` ignores already-deleted files |
| Partial line from a crashed write | Kept while recent; dropped as malformed after 60 s idle |
| A single huge "line" | Skipped chunk by chunk as malformed; the file never blocks |
| Malformed line (manual edit, old format) | Skipped, counted in `warnings` |
| cwd deleted since the command ran | `resolveProject` falls back to the resolved path (Task 3) |
| rc file is a symlink | Stays a symlink; target file updated |
| rc block present with an old script path | Replaced, never duplicated |

## 8. Deviations from the plan

1. **Cursor shape.** The plan says "the byte cursor (key = the `*.ingesting` file name)". I use **one** cursor row, `('shell', 'ingesting')`, holding a JSON map `{ fileName: offset }`. The behavior is identical. The difference: `Repo` has no way to delete a cursor, and every ingest creates a uniquely named file, so per-file rows would grow without limit. Alternative: add `deleteCursor` to `Repo` (an interface change). Please confirm the map, or ask for `deleteCursor`.
2. **bash duration is `-1` on every bash version, not only bash < 5.** R-B7 says bash ≥ 5 uses `$EPOCHREALTIME`, and it does, for the **timestamp**. A duration needs a start time, and the `history 1` approach runs only *after* the command, on every version. A bash ≥ 4.4 start time is possible with a `PS0` trick, `PS0='${__leftoff[__leftoff_start=…]}'`: an arithmetic side effect inside a parameter expansion. I didn't add it: there's no bash 5 on this machine to test it, and it's fragile. Please decide whether you want it (it would be tested in CI on Linux).
3. **Rotated file name** `shell.log.<ms>.<pid>.ingesting` instead of `shell.log.<pid>.ingesting`, so names are unique and sort oldest first.
4. **Abandoned partial lines** are dropped after 60 s idle instead of being "appended to `shell.log`" (R-B6 text). Appending a fragment to a live file could glue it onto the next command a shell writes. A line that nobody has written to for a minute can't be completed anyway.
5. **Extra test support files:** `tests/shell/run-shell.ts` (interactive shell runner) and the fixture `tests/fixtures/shell/basic.log`, which the plan lists as `tests/fixtures/shell/*.log`.
6. **Plan text** (owner-requested fold-ins): Task 3's redaction list now includes the `pass`/`auth` segment rule, the `redactDeep` key rule, and the mysql/sshpass rules; Task 18's README plan includes the leading-space note. I did **not** change Task 4's plan text for §8.1–8.4; I'll update it once you've answered.

## 9. Open questions and risks

1. **The fish script has never been run.** fish isn't installed here (your instruction: don't install it). The 6 fish tests skip locally and will run in CI (which installs fish) when you push. Specific uncertainties:
   - whether `fish --no-config -i` fed from stdin fires `fish_preexec`/`fish_postexec`;
   - `$status` inside `fish_postexec`;
   - `$CMD_DURATION` in that mode.

   If the fish jobs fail, please paste the CI output and I'll fix it with a test.
2. **bash 3.2 cost is about 3 ms per command,** under the 5 ms budget but close. The hook forks twice, for `$(history 1)` and, on bash < 5 only, `$(date +%s)`. Task 16 measures it formally. If it's too slow on your machine, an option is to drop `date` and write the timestamp as `0`, letting the collector use the time it reads the line. That would be less accurate.
3. **Please answer §8.1** (cursor map vs `deleteCursor`) and **§8.2** (bash `PS0` duration or not).
4. **`ignore.projects` / `ignore.commands` are applied only by the shell collector so far.** P10 says "projects/commands can be ignored by config". The plan text only puts it in the shell collector, but the Claude and Codex collectors (Tasks 6–7) should probably skip ignored projects too. The glob helper is internal to `shell.ts` for now; if you agree, Task 6 moves it to a shared module and applies it there.
5. **A bash `cd` line records the destination folder** (cwd at the next prompt), while zsh records the starting folder. This affects only which project a `cd` command is attributed to.

## 10. Commit

Commit `8476acf`, message `feat(shell): shell hooks, shell collector, rc installer`.

```
$ git show --stat --format='%h %s' 8476acf
8476acf feat(shell): shell hooks, shell collector, rc installer

 docs/PROGRESS.md                    |   6 +-
 docs/leftoff-implementation-plan.md |   4 +-
 docs/reports/task-03.md             |  27 +-
 docs/reports/task-04.md             | 480 ++++++++++++++++++++++++++++++++++++
 shell/leftoff.bash                  |  57 +++++
 shell/leftoff.fish                  |  40 +++
 shell/leftoff.zsh                   |  40 +++
 src/collectors/shell.ts             | 233 +++++++++++++++++
 src/collectors/types.ts             |  27 ++
 src/install/shell-rc.ts             |  82 ++++++
 src/model/redact.ts                 |   4 +
 tests/collectors/shell.test.ts      | 295 ++++++++++++++++++++++
 tests/fixtures/shell/basic.log      |   5 +
 tests/install/shell-rc.test.ts      | 159 ++++++++++++
 tests/model/redact.test.ts          |  19 ++
 tests/shell/hooks.test.ts           | 213 ++++++++++++++++
 tests/shell/run-shell.ts            |  37 +++
 17 files changed, 1722 insertions(+), 6 deletions(-)
```

**CI result (owner):** red on all 6 jobs. Everything passed except 4 fish hook tests, reproduced by the owner on Linux (Node 22, fish 3.7). Root cause: fish does not emit `fish_preexec`/`fish_postexec` when commands come from piped stdin, even with `-i`. The hook script itself was correct, as the owner confirmed under a pty. Fixed in Task 5's commit by running fish under `script` (see task-05.md §4, Part A).

Owner's answers:
- §8.1: keep the JSON-map cursor.
- §8.2: keep `-1` on all bash versions; no `PS0` trick.
- §8.3–8.5: approved.
- §9.2: fine; Task 16 measures it.
- §9.4: move the glob helper to a shared module in Task 6 and apply `ignore.projects` in the Claude and Codex collectors.
- §9.5: accepted.
