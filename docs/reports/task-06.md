# Task 06: Incremental JSONL reader and Claude Code collector

**Status: done.** The owner reviewed the fixture contents (§6.1) and approved the commit.

## 1. Goal

From the plan (Task 6):
- `readJsonlFrom(file, offset, maxBytes)`: incremental reading of append-only JSONL. Returns complete lines only, a correct `nextOffset`, stops after `maxBytes`, and restarts at 0 if the file shrank.
- `claudeCollector` and `parseClaudeRecord`: Claude Code transcripts become `user_prompt`, `agent_message`, `file_edit`, `command`, `command_failed`, `tool_error` and `test_failed` events. Built from **real fixtures** captured first (Step 1). Requirements:
  - `$CLAUDE_CONFIG_DIR` honored (R-C6);
  - the first run only looks at the last `retentionDays` (R-D4);
  - sessions inside `LEFTOFF_HOME` ignored (Review Focus 1);
  - malformed and partial lines handled (Review Focus 2);
  - `ignore.projects` applied through a shared module (your answer to Task 4 §9.4).

Folded in at your request (decision on Task 5 §9.1): **only your own commits.** `commit` events are limited to commits whose author email equals that repo's `git config user.email`, merges are skipped, and if no email is set nothing is filtered and that is logged once.

## 2. Files

| File | Purpose |
|---|---|
| `src/collectors/jsonl-reader.ts` | **New:** `readJsonlFrom` |
| `src/collectors/claude.ts` | **New:** `claudeCollector`, `parseClaudeRecord`, `claudeDir`, `PendingTool` |
| `src/collectors/ignore.ts` | **New:** `compileIgnore`, the shared `ignore.projects`/`ignore.commands` globs (moved out of `shell.ts`) |
| `src/collectors/shell.ts` | Uses `compileIgnore` (pure move; its 24 tests unchanged and passing) |
| `src/collectors/git.ts` | **Fold-in:** author-email filter, `--no-merges`, once-per-repo log, `noEmailLogged` in the cursor |
| `tests/collectors/jsonl-reader.test.ts` | 9 tests, including the 60 MB perf test |
| `tests/collectors/claude.test.ts` | 22 tests on the real fixture plus synthetic records |
| `tests/collectors/ignore.test.ts` | 5 tests |
| `tests/collectors/git.test.ts` | 4 new fold-in tests; the collector's git calls are isolated from your global git config |
| `tests/helpers/git.ts` | `initRepo(…, email)` sets the repo's own `user.email`; `commit(…, author)` |
| `tests/fixtures/claude/session-basic.jsonl` | The real, sanitized transcript (95 records) |
| `tests/fixtures/claude/session-malformed.jsonl` | basic + 2 corrupted lines + 1 unknown record type + 1 unknown content block |
| `tests/fixtures/claude/session-partial.jsonl` | basic with the last line cut in half |
| `tests/fixtures/claude/README.md` | Claude Code version, scenario, how the file was sanitized, record shapes, hook stdin fields |
| `docs/leftoff-implementation-plan.md` | Task 5 text: the author-email decision and the cursor shape |
| `docs/reports/task-06.md` | This report |
| `docs/reports/task-05.md` | §10 backfilled |
| `docs/PROGRESS.md` | Task 5 hash, Task 6 entry |

## 3. Interfaces produced

**`src/collectors/jsonl-reader.ts`** (used by Task 7 Codex, and any future agent collector)
- `interface JsonlRead { records: { value: unknown; endOffset: number }[]; nextOffset: number; malformed: number }`
- `readJsonlFrom(file: string, offset: number, maxBytes: number): Promise<JsonlRead>`. It rejects with `ENOENT` if the file is missing (callers decide).

**`src/collectors/claude.ts`** (used by Task 8, and Task 13 for hook-reported transcript paths)
- `claudeCollector: Collector` (`name: 'claude'`):
  - `isAvailable`: `<claudeDir>/projects` exists.
  - **Cursors:** per file, key = transcript path, value = JSON `{ offset, toolUses }`; plus `('claude', '__scan')` = time of the last scan (see §8).
  - **Warnings:** `malformed:<n>:<file>`.
- `parseClaudeRecord(rec: unknown, file: string, endOffset: number, tools?: Map<string, PendingTool>): WorkEvent[]`. Exported for tests, as the plan says; the optional 4th argument carries tool calls across records.
- `claudeDir(): string` returns `$CLAUDE_CONFIG_DIR` or `~/.claude`. Task 15's doctor will use it.
- `interface PendingTool { name; command?; path? }`

**`src/collectors/ignore.ts`** (used by the shell, Claude, and Task 7 Codex collectors)
- `interface Ignore { isIgnoredProject(path): boolean; isIgnoredCommand(command): boolean }`
- `compileIgnore(config: Config): Ignore`

## 4. How it works

### What the real transcript taught us (Claude Code 2.1.310)

The full shapes are in `tests/fixtures/claude/README.md`. Four points drove the design:

1. **Only `user` and `assistant` records carry work.** The 185-record raw file also had `attachment`, `mode`, `ai-title`, `file-history-snapshot`, `system`, `cost-state` and three `api-request*` types.
2. **`api-request-blob` records repeat tool calls with the *same tool-use id*** but a rewritten command (`cd /private/tmp/leftoff-fixture && node --test 2>&1` instead of `node --test 2>&1`). Reading them would double every command. They're excluded by type, and a test proves that even a blob *with* `cwd` and `timestamp` produces nothing.
3. **A tool result doesn't contain the command.** `toolUseResult` is a plain string on error (`"Error: Exit code 1\n…"`) and an object on success (`{ stdout, stderr, … }`), and neither names the command. So the collector remembers tool calls by id until their result arrives, **across runs**: pending calls are stored in the file's cursor (at most 500).
4. **Success or failure is known only from the result**, so `command`, `command_failed`, `tool_error` and `file_edit` are emitted when the result is read, not when the tool is called.

### Mapping

| Record | Event |
|---|---|
| `user` with string content (or text blocks), not `isMeta`, not `<command-…>` / `<local-command…>` / `<system-reminder>` | `user_prompt`, the text |
| `assistant` `text` block | `agent_message`, the **last** 300 characters (`…` + 299): conclusions come at the end |
| `tool_use` | remembered: `{ name, command, path }` |
| `tool_result` for **Bash**, no error | `command`, `data { command, exitCode: 0 }` |
| `tool_result` for **Bash**, `is_error` | `command_failed`, summary `` `cmd` failed: <first error line> ``, `data { command, exitCode (from "Exit code N"), error (≤ 1000 chars) }` |
| … and the output matches the plan's test regex | also `test_failed`, summary `` Tests failed: `cmd` `` |
| `tool_result` for **Edit/Write/MultiEdit/NotebookEdit**, no error | `file_edit`, summary `Edited calc.js` / `Wrote …` (relative to the project), `data { path, tool }` |
| any other tool's result with `is_error` | `tool_error`, summary `<Tool> failed: <first line>`, `data { tool, error }` |
| `thinking`, unknown blocks, unknown record types | nothing |

Every event:
- `projectRoot = resolveProject(record.cwd)`, `ts = record.timestamp`, `sessionRef = sessionId`;
- `dedupeKey('claude', file, endOffset, index)` (plan);
- built through `makeEvent`, so redacted and size-limited.

Events whose project is inside `LEFTOFF_HOME` or matches `ignore.projects` are dropped.

The actual events from the real fixture (these are what the tests assert):

```
14:18:10 user_prompt     Run ls /nope and tell me what happened.
14:18:19 command_failed  `ls /nope` failed: ls: /nope: No such file or directory
14:18:30 agent_message   I ran `ls /nope` and it failed with exit code 1, printing this error: …
14:18:47 user_prompt     Read the file notes.md.
14:18:52 tool_error      Read failed: File does not exist. Note: your current working directory is /private/tmp/leftoff-fixture.
14:18:56 agent_message   There's no `notes.md` in `/private/tmp/leftoff-fixture`, so I couldn't read it. …
14:20:04 user_prompt     Run node --test and show me the result.
14:20:10 command_failed  `node --test 2>&1` failed: ✖ add (0.986291ms)
14:20:10 test_failed     Tests failed: `node --test 2>&1`
14:20:15 agent_message   … Expected values to be strictly equal: -1 !== 5 …
14:22:15 user_prompt     Fix the bug in add in calc.js with the Edit tool. Don't run the tests yet.
14:22:25 file_edit       Edited calc.js
14:22:31 agent_message   I fixed `add` in `calc.js`: it was subtracting (`a - b`), and now it adds …
14:22:34 user_prompt     Run node --test again.
14:22:38 command         node --test 2>&1
14:22:42 agent_message   The fix works: the `add` test now passes, with 1 of 1 tests passing and no failures. …
14:23:04 user_prompt     Run npm run lint. If it fails, try one other way, then stop without fixing anything.
14:23:16 command_failed  `npm run lint 2>&1` failed: npm error Missing script: "lint"
14:23:21 agent_message   That failed because `package.json` has no `lint` script. The other way I'll try is …
14:23:24 command_failed  `npx --no-install eslint . 2>&1` failed: npm error npx canceled due to missing packages …
14:23:34 agent_message   …stalled in the project: `npx canceled due to missing packages …`. I used `--no-install` …
14:23:38 user_prompt     Reply with exactly: All tests pass, done.
14:23:42 agent_message   All tests pass, done.
```

### Which files are read

```ts
const lastScan = ctx.repo.getCursor('claude', SCAN_KEY);
const since = lastScan ? Date.parse(lastScan) - DAY_MS : ctx.now.getTime() - ctx.config.retentionDays * DAY_MS;
// every *.jsonl under <claudeDir>/projects (recursively) with mtime >= since,
// plus every transcriptPath recorded by a claude hook event since then
```

- `<claudeDir>` is `$CLAUDE_CONFIG_DIR`, or `~/.claude` (R-C6).
- **First run:** files modified in the last `retentionDays` (R-D4). **Later runs:** files modified since the last scan, minus one day. This is the plan's rule ("newer than the newest claude cursor update minus 1 day") with the time stored explicitly, because `Repo` doesn't expose cursor update times.
- **Each file:**
  - read from its cursor offset with `readJsonlFrom`, at most `ingest.maxBytesPerFilePerRun`;
  - if the file got smaller than the offset, the reader restarts at 0 and the pending tool calls are dropped;
  - the new cursor is `{ offset: nextOffset, toolUses: <still pending> }`.

### The JSONL reader

The file is read in 1 MiB chunks from `offset` up to `offset + maxBytes`; a line that continues past a chunk boundary is carried into the next chunk.

```ts
for (let nl = buf.indexOf(NEWLINE, from); nl !== -1 && nl < bytesRead; nl = buf.indexOf(NEWLINE, from)) {
  const piece = buf.subarray(from, nl);
  const line = pending.length > 0 ? Buffer.concat([...pending, piece]) : piece;
  …
  result.nextOffset = pos + from;              // only ever the end of a complete line
  try { result.records.push({ value: JSON.parse(text), endOffset: result.nextOffset }); }
  catch { result.malformed++; }
}
```

- Offsets are **bytes**, so multi-byte characters across chunk edges are handled (tested with > 1 MiB of `é😀` lines).
- Blank lines and `\r\n` are fine.
- **A single line longer than `maxBytes`** can never be read whole: it's skipped as malformed instead of stalling the file forever. Same rule as the shell collector.
- **Speed:** the first 50 MB of a 60 MB file are read and parsed in **147 ms** (budget 3 s).

### Fold-in: only your own commits

```ts
const email = await userEmail(root);              // git config --get user.email, per repo
const filters = ['--no-merges', ...(email ? ['-i', `--author=<${escapeRegExp(email)}>`] : [])];
```

- `--author=<email>` is matched inside angle brackets, so `me@x.com` doesn't match `notme@x.com`; `-i` ignores case.
- If `user.email` isn't set: no author filter, and `logError('git', 'user.email is not set in <repo>; counting every author's commits as yours')`, **once per repo**. The `noEmailLogged` flag in that repo's cursor remembers it; it resets if an email is set later and then removed again.

## 5. Design decisions

| Decision | Alternatives | Why |
|---|---|---|
| Read only `user`/`assistant` records | Read anything with `message` | `api-request-blob` copies would double every command |
| Emit tool events when the **result** arrives | At the tool call (plan wording "tool uses named Edit … → file_edit") | Only the result says whether it worked; a failed Edit is a `tool_error`, not an edit |
| Pending tool calls stored in the file cursor (≤ 500) | Re-derive from the file each run | The plan suggests this ("keep a per-file map … in the cursor value as JSON"); a result can be read a run later than its call (tested) |
| `test_failed` only for **failed** Bash results | Any Bash output matching the regex (plan) | The regex's `\d+ (failed\|failing)` matches "0 failed" in passing runs. See §8.2 |
| Agent message = last 300 characters | First 300 | Plan says "keep last 300 chars"; the conclusion is at the end |
| `command_failed` summary includes the first error line | Just the command | The brief and open problems (Task 9) need the error ("SMTP connection refused"); the command is in `data.command` |
| `exitCode` parsed from `Exit code N` | Always 1 | Claude Code prints the real code; it matters for the brief |
| Slash commands, command output, `isMeta`, system reminders are not prompts | Keep all user text | `/clear` isn't an intent; "last intent" (Task 9) must be a real prompt |
| Scan time stored in a cursor (`__scan`) | Read `updated_at` of cursors | `Repo` has no such method; no interface change needed |
| Shared `compileIgnore` | Copy the helper into each collector | Owner decision (Task 4 §9.4) |
| Fixture sanitized, not synthetic | Hand-written JSONL | Plan: real fixtures; real files revealed points 2–4 above |
| Fixture keeps the 5 assistant `api-request-blob` copies | Drop all of them | They're the hazard the collector must handle |
| Sanitize script kept out of the repo | Commit it | It reads your real `~/.claude` file; the steps are in the fixtures README |

## 6. Tests

### 6.1 The fixture's full contents, for your review

`tests/fixtures/claude/session-basic.jsonl`, one line per record. Message text is cut to about 70 characters here; the file has the full text.

```
 1  last-prompt               undefined
 2  mode                      
 3  permission-mode           
 4  atis-latch                
 5  file-history-snapshot     
 6  user                      text: "Run ls /nope and tell me what happened."
 7  attachment                {"type":"model","identity":{"modelId":"claude-opus-5-5","marketingName":"Opus 5.5","knowle
 8  attachment                {"type":"date","date":"2026-10-26"}
 9  last-prompt               "Run ls /nope and tell me what happened."
10  mode                      
11  permission-mode           
12  atis-latch                
13  ai-title                  "Ls /nope error"
14  assistant                 tool_use Bash {"command":"ls /nope","description":"List a nonexistent directory"}
15  user                      tool_result ERROR: "Exit code 1\nls: /nope: No such file or directory"
16  last-prompt               "Run ls /nope and tell me what happened."
17  ai-title                  "Ls /nope error"
18  mode                      
19  permission-mode           
20  atis-latch                
21  assistant                 text: "I ran `ls /nope` and it failed with exit code 1, printing this error:\n"
22  system                    stop_hook_summary [{"command":"bash \"${CLAUDE_PLUGIN_ROOT}/hooks/example-hook.sh\""}]
23  system                    turn_duration
24  file-history-snapshot     
25  user                      text: "Read the file notes.md."
26  assistant                 tool_use Read {"file_path":"/private/tmp/leftoff-fixture/notes.md"}
27  user                      tool_result ERROR: "File does not exist. Note: your current working directory is"
28  assistant                 thinking
29  assistant                 text: "There's no `notes.md` in `/private/tmp/leftoff-fixture`, so I couldn't"
30  system                    stop_hook_summary [{"command":"bash \"${CLAUDE_PLUGIN_ROOT}/hooks/example-hook.sh\""}]
31  system                    turn_duration
32  file-history-snapshot     
33  user                      text: "Run node --test and show me the result."
34  assistant                 tool_use Bash {"command":"node --test 2>&1","description":"Run Node test runner"}
35  user                      tool_result ERROR: "Exit code 1\n✖ add (0.986291ms)\nℹ tests 1\nℹ suites 0\nℹ pass 0"
36  api-request-blob(assistant)tool_use Bash {"command":"cd /private/tmp/leftoff-fixture && node --test 2>&1","desc
37  assistant                 thinking
38  assistant                 text: "The test run failed: 1 test ran and it didn't pass (exit code 1).\n\nThe"
39  system                    stop_hook_summary [{"command":"bash \"${CLAUDE_PLUGIN_ROOT}/hooks/example-hook.sh\""}]
40  system                    turn_duration
41  last-prompt               "Run node --test and show me the result."
42  ai-title                  "Ls /nope error"
43  mode                      
44  permission-mode           
45  atis-latch                
46  file-history-snapshot     
47  user                      text: "Fix the bug in add in calc.js with the Edit tool. Don't run the tests yet."
48  assistant                 tool_use Read {"file_path":"/private/tmp/leftoff-fixture/calc.js"}
49  user                      tool_result: "1\texport function add(a, b) {\n2\t  return a - b;\n3\t}\n4\t"
50  assistant                 tool_use Edit {"replace_all":false,"file_path":"/private/tmp/leftoff-fixture/calc.js
51  file-history-delta        
52  user                      tool_result: "The file /private/tmp/leftoff-fixture/calc.js has been updat"
53  api-request-blob(assistant)tool_use Edit {"file_path":"/private/tmp/leftoff-fixture/calc.js","old_string":"  re
54  assistant                 text: "I fixed `add` in `calc.js`: it was subtracting (`a - b`), and now it a"
55  system                    stop_hook_summary [{"command":"bash \"${CLAUDE_PLUGIN_ROOT}/hooks/example-hook.sh\""}]
56  system                    turn_duration
57  user                      text: "Run node --test again."
58  file-history-snapshot     
59  assistant                 tool_use Bash {"command":"node --test 2>&1","description":"Run Node test runner"}
60  user                      tool_result: "✔ add (0.4145ms)\nℹ tests 1\nℹ suites 0\nℹ pass 1\nℹ fail 0\nℹ ca"
61  api-request-blob(assistant)tool_use Bash {"command":"cd /private/tmp/leftoff-fixture && node --test 2>&1","desc
62  assistant                 thinking
63  assistant                 text: "The fix works: the `add` test now passes, with 1 of 1 tests passing an"
64  system                    stop_hook_summary [{"command":"bash \"${CLAUDE_PLUGIN_ROOT}/hooks/example-hook.sh\""}]
65  system                    turn_duration
66  last-prompt               "Run node --test again."
67  ai-title                  "Ls /nope error"
68  mode                      
69  permission-mode           
70  atis-latch                
71  user                      text: "Run npm run lint. If it fails, try one other way, then stop without fixing anything."
72  file-history-snapshot     
73  assistant                 tool_use Bash {"command":"npm run lint 2>&1","description":"Run the lint script"}
74  user                      tool_result ERROR: "Exit code 1\nnpm error Missing script: \"lint\"\nnpm error\nnpm e"
75  api-request-blob(assistant)tool_use Bash {"command":"cd /private/tmp/leftoff-fixture && npm run lint 2>&1","des
76  assistant                 thinking
77  assistant                 text: "That failed because `package.json` has no `lint` script. The other way"
78  assistant                 tool_use Bash {"command":"npx --no-install eslint . 2>&1","description":"Run ESLint 
79  user                      tool_result ERROR: "Exit code 1\nnpm error npx canceled due to missing packages a"
80  api-request-blob(assistant)thinking | text: "That failed because `package.json` has no `lint` script. The other way" | tool_use Bash {"command":"cd /private/tmp/leftoff-fixture && npx --no-install eslint
81  assistant                 thinking
82  assistant                 text: "Lint didn't run either way. I've stopped there and haven't changed any"
83  system                    stop_hook_summary [{"command":"bash \"${CLAUDE_PLUGIN_ROOT}/hooks/example-hook.sh\""}]
84  system                    turn_duration
85  user                      text: "Reply with exactly: All tests pass, done."
86  file-history-snapshot     
87  last-prompt               "Reply with exactly: All tests pass, done."
88  ai-title                  "Ls /nope error"
89  mode                      
90  permission-mode           
91  atis-latch                
92  assistant                 thinking
93  assistant                 text: "All tests pass, done."
94  system                    stop_hook_summary [{"command":"bash \"${CLAUDE_PLUGIN_ROOT}/hooks/example-hook.sh\""}]
95  system                    turn_duration
```

**Personal-data scan of the committed file:**
- 0 matches for: your name, `gmail`, `apple`, `MacBook`, `superpowers`, `context7`, `GITHUBTANMAY`, `/Users/` (other than `/Users/dev`), `leftoff/`;
- no email address of any kind;
- the only paths are `/private/tmp/leftoff-fixture/…` and `/Users/dev/.npm/_logs/2026-10-26T…-debug-0.log` (from npm's error output).

**What remains that you might still want removed:**
- the model name (`claude-opus-5-5`) and Claude Code version;
- random session, message and tool-use ids;
- the `atis` id;
- the dates (2026-10-26);
- the full text of my replies in that session.

Please confirm, or tell me what else to strip.

### 6.2 RED

```
tests/collectors/jsonl-reader.test.ts → Error: Cannot find module '../../src/collectors/jsonl-reader.ts'
tests/collectors/ignore.test.ts       → Error: Cannot find module '../../src/collectors/ignore.ts'
tests/collectors/claude.test.ts       → Error: Cannot find module '../../src/collectors/claude.ts'
git fold-in (3 failing; the case test passed vacuously until filtering existed):
   × a teammate's commit after a pull is excluded, and the pull's merge commit is skipped
   × user.email is read per repo: two repos, two different "you"s
   × user.email unset: all commits are kept and it is logged once
```

### 6.3 Mutation checks (code broken on purpose, then restored)

| Break | Caught by |
|---|---|
| Merge commits kept | teammate-after-pull test |
| Case-sensitive email match | `the email match ignores case` |
| "No email" logged every run | `user.email unset: … logged once` |
| Reader doesn't restart after the file shrank | `reader restarts at 0 when file shrank` |
| Lines across chunk edges not joined | `lines crossing the internal read-chunk boundary …` |
| Over-long line not skipped | `a single line longer than maxBytes … instead of stalling` |
| `api-request-blob` read as work | **survived at first** (the copies have no `cwd`); added `api-request-blob copies are never read as work, even with cwd and timestamp`, which now catches it |
| Tool calls forgotten between runs | `a tool call and its result read in different runs are still linked` |
| No `LEFTOFF_HOME` guard | `sessions whose cwd is inside LEFTOFF_HOME are ignored` |
| `ignore.projects` not applied | `ignore.projects drops a project …` |
| Slash commands counted as prompts | `slash commands, command output and meta records are not user prompts` |
| First run reads all history | `first run (no cursors) only considers files modified within retentionDays` |
| Hook-reported paths ignored | `a transcript path reported by a hook event is read …` |
| Agent message keeps the start | `agent messages keep the last 300 characters` |

### 6.4 Tests

`tests/collectors/claude.test.ts` (22): basic session → kinds in order *(plan)*; failed Bash linked to its command *(plan)*; commands from the assistant record, not the request copies; tool_error and test_failed; file_edit with path; prompts/messages/timestamps/session id; project root from cwd *(plan)*; malformed and unknown lines skipped and counted *(plan)*; partial last line not consumed, then read *(plan)*; re-reading yields no new events, with stable keys *(plan)*; call and result in different runs; last 300 characters; slash commands/meta not prompts; secrets redacted; LEFTOFF_HOME ignored *(plan)*; ignore.projects; CLAUDE_CONFIG_DIR *(R-C6)*; first run within retentionDays *(R-D4)*; hook-reported path read; no projects folder; parseClaudeRecord ignores other record types; api-request-blob never read.

`tests/collectors/jsonl-reader.test.ts` (9): complete lines and nextOffset *(plan)*; continue from nextOffset; restart after shrink *(plan)*; stop at maxBytes and resume *(plan)*; malformed/blank/CRLF; over-long line skipped; chunk-boundary lines; ENOENT; **60 MB file, first 50 MB within 3 s** *(plan, R-D5; took 147 ms)*.

`tests/collectors/ignore.test.ts` (5): folder and everything under it; `*` vs `**`; `~`; command globs on normalized commands; empty lists.

`tests/collectors/git.test.ts` (fold-in, 4 new): teammate's commit after a real `git pull` excluded and the merge skipped; two repos with two emails; case-insensitive; unset email → all commits, logged once.

### 6.5 Final run (`npm run check`)

```
> tsc --noEmit && eslint . && prettier --check . && vitest run --project unit

Checking formatting...
All matched files use Prettier code style!

 Test Files  17 passed (17)
      Tests  268 passed | 1 skipped (269)
```

269 = 229 (Task 5) + 4 (git fold-in) + 5 (ignore) + 9 (reader) + 22 (claude). The 1 skipped is the fish raw-tab test, by design.

## 7. Edge cases and failure handling

| Situation | Behavior |
|---|---|
| No `~/.claude/projects` (or `$CLAUDE_CONFIG_DIR` wrong) | `isAvailable` false; `collect` returns no events, no throw |
| Transcript still being written (partial last line) | Not consumed; read on the next run |
| Corrupted line / unknown record type / unknown block type | Skipped; corrupted lines counted in `malformed:<n>:<file>` |
| Claude Code adds new fields or record types | Ignored (only the fields in §4 are read) |
| Tool call in one run, result in the next | Linked through the cursor's pending calls |
| Result without a known call (call older than 500 pending, or file restarted) | Errors still become `tool_error` ("A tool failed: …"); successes are dropped |
| Huge transcript (multi-GB) | At most `maxBytesPerFilePerRun` (50 MB) per file per run; continues next run |
| A single gigantic line (e.g. pasted image) longer than the cap | Skipped as malformed, never stalls |
| Transcript rewritten / truncated | Reader restarts at 0, pending calls dropped; dedupe keys (file + offset) mean re-read lines that match earlier ones are not duplicated |
| Hook-reported transcript deleted | Skipped silently |
| Polish sessions (`cwd` in `~/.leftoff/tmp`) | Dropped (recursion guard) |
| Secrets in commands or tool output | Redacted by `makeEvent` (tested) |
| Repo without `user.email` | All commits kept; logged once per repo |

## 8. Deviations from the plan

1. **Claude cursor value is JSON** `{ offset, toolUses }`, not just `nextOffset`. The plan itself suggests this for tool-call matching. There's also one extra cursor `('claude','__scan')` for the "since last scan" rule, because `Repo` doesn't expose cursor update times.
2. **`test_failed` only for failed Bash results.** The plan's regex alone would flag passing runs that print "0 failed". Related: Node's test runner prints `ℹ fail 1`, which the regex doesn't match; here it was caught by `AssertionError`, but a failing test without an assertion error (timeout, crash) would be missed. **Proposal:** add `\bfail(ed|ing)?:? [1-9]` to the regex, to cover `ℹ fail 1` / `# fail 1`. Your call.
3. **Tool events at result time** (§5).
4. **`command_failed` summary includes the first error line.**
5. **`session_start` / `session_end` are not derived from transcripts.** The plan lists them under the collector's outputs, but the transcript has no explicit start/end record; the SessionStart/SessionEnd hooks (Task 13) record them. I didn't invent them from the first and last record.
6. **Fold-in:** the plan text for Task 5 now describes the author-email rule and the git cursor's `noEmailLogged` flag.

## 9. Open questions and risks

1. **Please review the fixture (§6.1) and confirm it can be committed**, or tell me what else to strip.
2. **§8.2:** extend the test-failure regex for `ℹ fail N`?
3. **Subagent transcripts:** Claude Code may write subagent sessions in separate files under the project folder. They're picked up (the scan is recursive), and their work appears under the same project. Their records weren't in this fixture (no subagents ran), so I can't confirm their shape yet; flagging for dogfooding.
4. **Hook-reported paths and the event query:** on the first run, the collector loads the last `retentionDays` of events to find `transcriptPath`s, which may be slow on a big database. Later runs only look back to the last scan. Task 16 measures it.
5. **Format drift:** this is Claude Code 2.1.310. The parser ignores everything it doesn't know, and `doctor` (Task 15) reports malformed counts. A changed field name (e.g. `tool_use_id`) would silently produce fewer events, though. Task 17's dogfooding is where that would show.

## 10. Commit

Commit `620bb27`, message `feat(claude): incremental jsonl reader and claude code collector`. The owner reviewed and approved the fixture before the commit.

```
$ git show --stat --format='%h %s' 620bb27
620bb27 feat(claude): incremental jsonl reader and claude code collector

 docs/PROGRESS.md                              |   6 +-
 docs/leftoff-implementation-plan.md           |   2 +
 docs/reports/task-05.md                       |  23 +-
 docs/reports/task-06.md                       | 394 ++++++++++++++++++++++++++
 src/collectors/claude.ts                      | 263 +++++++++++++++++
 src/collectors/git.ts                         |  33 ++-
 src/collectors/ignore.ts                      |  56 ++++
 src/collectors/jsonl-reader.ts                |  67 +++++
 src/collectors/shell.ts                       |  55 +---
 tests/collectors/claude.test.ts               | 378 ++++++++++++++++++++++++
 tests/collectors/git.test.ts                  |  71 ++++-
 tests/collectors/ignore.test.ts               |  43 +++
 tests/collectors/jsonl-reader.test.ts         | 123 ++++++++
 tests/fixtures/claude/README.md               |  68 +++++
 tests/fixtures/claude/session-basic.jsonl     |  95 +++++++
 tests/fixtures/claude/session-malformed.jsonl |  99 +++++++
 tests/fixtures/claude/session-partial.jsonl   |  95 +++++++
 tests/helpers/git.ts                          |  13 +-
 18 files changed, 1825 insertions(+), 59 deletions(-)
```

Owner's answer to §8.2: extend the test-failure patterns (Node/TAP, Go, cargo, pytest/jest/vitest) in one place, with zero cases tested. Done in Task 7.
