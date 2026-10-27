# Task 07: Codex CLI collector

**Status: done.** The owner reviewed the fixture (§6.1) and approved the commit.

## 1. Goal

From the plan (Task 7):
- `codexCollector` and `parseCodexRecord`: Codex CLI sessions become the same event kinds as the Claude scenario.
- **Step 0:** check that Codex runs with your login. It did: the first turn failed for model `gpt-6.1-sol` ("model not supported with a ChatGPT account"), and the rest of the session ran on `gpt-6-luna`.
- **Step 1b (R-A4):** decide `.zst` support from real files. You confirmed 15 `rollout-*.jsonl.zst` sessions exist and that Codex compresses older sessions. So: `node:zlib` zstd, `engines` raised to `>=22.15`, a `.zst` fixture made with the `zstd` CLI, and `codex.maxCompressedMb` kept.
- Plain files with a byte cursor; `.zst` files read fully once and re-read only when size or mtime change; `$CODEX_HOME` (R-C6); `ignore.projects` through the shared module (your answer to Task 4 §9.4).
- **Your extra requirement:** a session that switches from `.jsonl` to `.jsonl.zst` between runs must not duplicate events.

Folded in (your answer to Task 6 §8.2): **one shared module of test-failure patterns**, covering Node/TAP, Go, cargo and pytest/jest/vitest/mocha, with tests that the zero cases do **not** match.

## 2. Files

| File | Purpose |
|---|---|
| `src/collectors/codex.ts` | **New:** `codexCollector`, `parseCodexRecord`, `codexDir`, `CodexState` |
| `src/collectors/jsonl-reader.ts` | **Added** `readZstJsonl` (streaming zstd decompression via `node:zlib`) |
| `src/collectors/test-failures.ts` | **New (fold-in):** `TEST_FAILURE_PATTERNS`, `looksLikeTestFailure` |
| `src/collectors/claude.ts` | Uses `looksLikeTestFailure` instead of its own regex |
| `tests/collectors/codex.test.ts` | **New:** 19 tests |
| `tests/collectors/test-failures.test.ts` | **New:** 24 tests (13 failing outputs, 10 passing outputs, pattern hygiene) |
| `tests/collectors/jsonl-reader.test.ts` | +1 test for `readZstJsonl` |
| `tests/collectors/claude.test.ts` | +1 test: failing Node run with no `AssertionError` is `test_failed` |
| `tests/fixtures/codex/session-basic.jsonl` | The real, sanitized session (144 records) |
| `tests/fixtures/codex/session-basic.jsonl.zst` | The same file compressed with `zstd -q -19` |
| `tests/fixtures/codex/session-malformed.jsonl` | basic + 2 corrupted lines + 1 unknown record type + 1 unknown item type |
| `tests/fixtures/codex/session-partial.jsonl` | basic with the last line cut in half |
| `tests/fixtures/codex/README.md` | Codex version, scenario, sanitization, record shapes, the files leftoff does not read |
| `package.json` | `engines.node` → `>=22.15` |
| `docs/leftoff-implementation-plan.md` | Engines; Task 6 test-failure text → shared module; Task 7 mapping as found in real data; file tree |
| `docs/reports/task-07.md` | This report |
| `docs/reports/task-06.md` | §10 backfilled |
| `docs/PROGRESS.md` | Task 6 hash; Task 7 entry |

## 3. Interfaces produced

**`src/collectors/codex.ts`** (used by Task 8's registry)
- `codexCollector: Collector` (`name: 'codex'`):
  - `isAvailable`: `<codexDir>/sessions` exists.
  - **Cursors:** a plain file `{ offset, cwd, threadId }`; a `.zst` file `{ size, mtimeMs, lines, cwd, threadId }`; plus `('codex','__scan')`.
  - **Warnings:** `malformed:<n>:<file>` and `too large, skipped: <file> (<n> MB > codex.maxCompressedMb <max>)`.
- `parseCodexRecord(rec: unknown, state: CodexState): WorkEvent[]`. The plan said `(rec, file, pos)`; see §8.
- `interface CodexState { cwd?: string | null; threadId?: string | null }`
- `codexDir(): string` returns `$CODEX_HOME` or `~/.codex` (Task 15's doctor will use it).

**`src/collectors/jsonl-reader.ts`**
- `readZstJsonl(file: string, skipLines: number): Promise<{ records: unknown[]; totalLines: number; malformed: number }>`: the plan's signature, with `node:zlib` instead of `fzstd` (R-A4).

**`src/collectors/test-failures.ts`** (used by the Claude and Codex collectors)
- `TEST_FAILURE_PATTERNS: { name: string; pattern: RegExp }[]`: one place to add frameworks.
- `looksLikeTestFailure(output: string): boolean`

## 4. How it works

### What the real session taught us (codex-cli 0.163.0)

Codex's format is nothing like Claude Code's, and not what the plan assumed ("shell/function calls → command"). Details are in `tests/fixtures/codex/README.md`. In short:
- Each line is `{ timestamp, ordinal, type, payload }`, and `ordinal` is unique within a session.
- **Tool calls are JavaScript snippets** in `response_item/custom_tool_call` records (`const r = await tools.exec_command({cmd:"ls /nope", …})`), and their outputs are text blobs. Parsing that would be fragile.
- **`event_msg` records of type `item_completed`** carry the same activity in a clean, structured form: `UserMessage`, `AgentMessage` (with `phase` `commentary` / `final_answer`), `CommandExecution` (`command`, `cwd`, `status`, `exit_code`, `aggregated_output`), `FileChange` (paths and change type) and `Reasoning`. They are already deduplicated.
- **So events come only from `item_completed`**, and every `response_item` is ignored. Two tests guard this: commands come out exactly once, and an `item_started` record with the same item adds nothing.

### Mapping

| `item_completed` item | Event |
|---|---|
| `UserMessage` | `user_prompt` (text starting with `<`, e.g. environment context, is skipped) |
| `AgentMessage` | `agent_message`, the last 300 characters, `data.phase` |
| `CommandExecution`, exit 0 and not `failed` | `command`, `data { command, exitCode }`. `["/bin/zsh","-lc","ls /nope"]` → `ls /nope` |
| `CommandExecution`, `failed` or exit ≠ 0 (e.g. 130 after Ctrl-C) | `command_failed`, summary `` `cmd` failed: <first output line> `` (or `exit code N` when there is no output), `data { command, exitCode, error }`; plus `test_failed` if the output looks like a failed test run |
| `FileChange`, completed | one `file_edit` per path: `Edited` / `Added` / `Deleted <relative path>`, `data { path, change }` |
| `FileChange`, not completed | `tool_error`: `Patch failed: <paths>` |
| `Reasoning`, unknown items, all other records | nothing |

- **cwd:** a command's own `cwd` (a `file://` URL), otherwise the session's cwd from `session_meta`/`turn_context`. That cwd is kept in `CodexState` and **saved in the cursor**, so a run that starts mid-session still knows the project (tested with a split right after the `turn_context`).
- **Every event:** `projectRoot = resolveProject(cwd)`, `ts = record timestamp`, `sessionRef = thread_id`, and `dedupeKey('codex', thread_id, ordinal, index)`. Then `makeEvent` redacts.

The events the collector produces from the real fixture (asserted by the tests):

```
14:47:14 user_prompt     Run ls /nope and tell me what happened.
14:47:21 agent_message   I'll run the command as requested and report its output.
14:47:23 command_failed  `ls /nope` failed: ls: /nope: No such file or directory
14:47:25 agent_message   `ls /nope` failed with exit code 1 because `/nope` does not exist: …
14:48:08 user_prompt     Show me the contents of notes.md.
14:48:11 agent_message   I'll locate `notes.md` in the workspace and display it.
14:48:11 command_failed  `rg --files -g 'notes.md' -g 'NOTES.md' -g 'Notes.md'` failed: exit code 1
14:48:14 agent_message   No tracked or visible match surfaced; I'll check the workspace root directly.
14:48:14 command         ls -la
14:48:16 agent_message   There's no `notes.md` in the workspace root, and my search found no matching file …
14:48:21 user_prompt     Run node --test and show me the result.
14:48:24 agent_message   I'll run Node's test runner from the workspace root and show the result.
14:48:24 command_failed  `node --test` failed: ✖ add (1.238375ms)
14:48:24 test_failed     Tests failed: `node --test`
14:48:27 agent_message   `node --test` ran one test and failed. The `add` test in `calc.test.js:5` expected `5` …
14:48:29 user_prompt     Fix the bug in add in calc.js. Don't run the tests yet.
14:48:31 agent_message   I'll inspect the calculator and its test, then make the smallest fix without running tests.
14:48:32 command         cat calc.js && cat calc.test.js
14:48:35 agent_message   The function subtracts its inputs; I'm changing it to return their sum.
14:48:36 file_edit       Edited calc.js
14:48:38 agent_message   Fixed `add` in `calc.js` to return `a + b`. I did not run the tests, as requested.
14:48:39 user_prompt     Run node --test again.
14:48:41 agent_message   I'll rerun `node --test` now and share the result.
14:48:42 command         node --test
14:48:44 agent_message   `node --test` passed: 1 test, 0 failures.
14:48:46 user_prompt     Run npm run lint. If it fails, try one other way, then stop without fixing anything.
14:48:49 agent_message   I'll run `npm run lint`; if it fails, I'll try one alternate lint command and stop there.
14:48:50 command_failed  `npm run lint` failed: npm error Missing script: "lint"
14:48:53 agent_message   `lint` is not configured in `package.json`; I'll try one direct ESLint invocation, then stop.
14:49:35 command_failed  `npx --no-install eslint .` failed: exit code 130
14:49:38 agent_message   `npm run lint` failed because no `lint` script is defined. The alternate … 
14:49:40 user_prompt     Reply with exactly: All tests pass, done.
14:49:43 agent_message   All tests pass, done.
```

### Plain and compressed files

```
for each sessions/**/rollout-*.jsonl[.zst] with mtime ≥ since:      // since: last scan − 1 day, or retentionDays on the first run
  .zst:  unchanged size and mtime → skip, without even opening it
         larger than codex.maxCompressedMb → warning, skip
         else stream-decompress, skip the first cursor.lines lines, parse the rest
  plain: readJsonlFrom(offset, maxBytesPerFilePerRun), like Claude
```

`readZstJsonl` streams: `createReadStream → createZstdDecompress → readline`. Memory stays flat even for a large session.

### The .jsonl → .jsonl.zst switch

When Codex compresses a session, the plain file disappears and a new path appears. A path-based dedupe key would re-import the whole session. Here the key is `(thread_id, ordinal, index)`, the same in both files, so the compressed file is read once and **every insert is a no-op**. The test reads the plain file and commits (33 rows), then replaces it with the `.zst`, collects again (same 33 keys) and commits: **0 rows inserted**.

### Fold-in: test-failure patterns

```ts
export const TEST_FAILURE_PATTERNS = [
  { name: 'N failed / N failing (N ≥ 1)', pattern: /\b[1-9]\d* (failed|failing)\b/ },
  { name: 'node test runner: ℹ fail N (N ≥ 1)', pattern: /^ℹ fail [1-9]\d*/m },
  { name: 'TAP: # fail N (N ≥ 1)', pattern: /^# fail [1-9]\d*/m },
  { name: 'go test: --- FAIL:', pattern: /^--- FAIL:/m },
  { name: 'FAIL at the start of a line (go, jest)', pattern: /^\s*FAIL\b/m },
  { name: 'cargo: test result: FAILED', pattern: /test result: FAILED/ },
  { name: 'AssertionError', pattern: /\bAssertionError\b/ },
];
```

- `[1-9]\d*` makes every zero case fail to match: `0 failed`, `0 failing`, `ℹ fail 0`, `# fail 0`.
- `\b` after `FAIL` keeps `FAILED` and `FAILOVER` out of the line-start rule (cargo's `FAILED` has its own rule).
- A test enforces that no pattern uses the `g` flag, which would make `RegExp.test` stateful.
- Both collectors still only call it on **failed** commands (Task 6 decision).

## 5. Design decisions

| Decision | Alternatives | Why |
|---|---|---|
| Events only from `item_completed` | Parse `custom_tool_call` JavaScript + outputs (closest to the plan's wording) | Structured, deduplicated, has real exit codes and paths; parsing generated JS would break with any rewording |
| Dedupe key `(thread_id, ordinal, index)` | `(file, offset, index)` like Claude | Survives the `.jsonl` → `.jsonl.zst` rename (your requirement) |
| `parseCodexRecord(rec, state)` | Plan: `(rec, file, pos)` | The file and position aren't needed for keys; the session cwd and thread id are |
| Session cwd and thread id saved in the cursor | Re-read `session_meta` every run | Incremental reads start mid-file |
| Commentary agent messages kept (`data.phase`) | Only `final_answer` | Same as Claude (all text); Task 9 can filter by phase if needed |
| Exit ≠ 0 is a failure even if `status` is `completed` | Trust `status` | Defensive; tested with a synthetic record |
| `.zst` unchanged → not opened at all | Open and skip lines | No decompression cost for the 15 old sessions on every run |
| Streaming zstd | `zstdDecompressSync` on the whole file | Bounded memory for big sessions |
| `engines >=22.15` | Keep `>=22.12` | `node:zlib` zstd exists from 22.15 (plan Step 1b) |
| Test-failure patterns in one exported list | Inline regex per collector | Your requirement; contributors edit one file and its test |
| Fixture `.zst` made with the `zstd` CLI | Compress in Node | Your instruction; the same tool family Codex output is read with |

## 6. Tests

### 6.1 The fixture's full contents, for your review

`tests/fixtures/codex/session-basic.jsonl`, one line per record. Text is cut to about 70 characters here; the file has the full text.

```
  1  session_meta                          {"id":"01a178ac-c430-7a40-878e-9b9ae07e45c4","session_id":"01a178ac-c430-7a40-878e-9b9ae07e45c4","timestamp":"2026-10-26T14:45:50.881Z","cwd":"/private/tmp/leftoff-codex-fixture","runtime_workspace_roots":["/private/tmp/leftoff-codex-fixture"],"originator":"codex-tui","cli_version":"0.163.0","source":"vscode","thread_source":"user","model_provider":"openai","history_mode":"paginated","git":{}}
  2  event_msg/task_started                task_started
  3  world_state                           {"full":false,"state":{"collaboration_mode":{"model":"gpt-6-luna","instructions":"afcdf1ff905fb4e61ff4d6d89af089dbda3d5e4e"},"model":"gpt-6-luna"}}
  4  turn_context                          {"turn_id":"01a178ae-0b4e-70e3-a73f-36f5b685a6e1","root_turn_id":"01a178ae-0b4e-70e3-a73f-36f5b685a6e1","cwd":"/private/tmp/leftoff-codex-fixture","approval_policy":"on-request","model":"gpt-6-luna"}
  5  response_item/message                 user: "Run ls /nope and tell me what happened."
  6  event_msg/item_completed              UserMessage: "Run ls /nope and tell me what happened."
  7  event_msg/item_completed              AgentMessage: "I’ll run the command as requested and report its output."
  8  response_item/message                 assistant: "I’ll run the command as requested and report its output."
  9  response_item/custom_tool_call        exec: "const r = await tools.exec_command({cmd:\"ls /nope\",max_output_tokens:2000});\ntex"
 10  token_usage_record                    usage numbers
 11  event_msg/item_completed              CommandExecution: "ls /nope" status=failed exit=1 out="ls: /nope: No such file or directory\n"
 12  response_item/custom_tool_call_output output: "Script completed\nWall time 0.1 seconds\nOutput:\n {\"chunk_id\":\"339b43\",\""
 13  event_msg/token_count                 token_count
 14  event_msg/item_completed              AgentMessage: "`ls /nope` failed with exit code 1 because `/nope` does not exist: `ls"
 15  response_item/message                 assistant: "`ls /nope` failed with exit code 1 because `/nope` does not exist: `ls"
 16  token_usage_record                    usage numbers
 17  event_msg/token_count                 token_count
 18  event_msg/task_complete               task_complete
 19  event_msg/task_started                task_started
 20  turn_context                          {"turn_id":"01a178ae-dd50-7c83-ae7f-b1e14713ed7a","root_turn_id":"01a178ae-dd50-7c83-ae7f-b1e14713ed7a","cwd":"/private/tmp/leftoff-codex-fixture","approval_policy":"on-request","model":"gpt-6-luna"}
 21  response_item/message                 user: "Show me the contents of notes.md."
 22  event_msg/item_completed              UserMessage: "Show me the contents of notes.md."
 23  event_msg/item_completed              AgentMessage: "I’ll locate `notes.md` in the workspace and display it."
 24  response_item/message                 assistant: "I’ll locate `notes.md` in the workspace and display it."
 25  response_item/custom_tool_call        exec: "const r = await tools.exec_command({cmd:\"rg --files -g 'notes.md' -g 'NOTES.md' "
 26  token_usage_record                    usage numbers
 27  event_msg/item_completed              CommandExecution: "rg --files -g 'notes.md' -g 'NOTES.md' -g 'Notes.md'" status=failed exit=1 out=""
 28  response_item/custom_tool_call_output output: "Script completed\nWall time 0.5 seconds\nOutput:\n "
 29  event_msg/token_count                 token_count
 30  event_msg/item_completed              Reasoning: ""
 31  response_item/reasoning               reasoning (encrypted_content="removed for fixture")
 32  event_msg/item_completed              AgentMessage: "No tracked or visible match surfaced; I’ll check the workspace root di"
 33  response_item/message                 assistant: "No tracked or visible match surfaced; I’ll check the workspace root di"
 34  response_item/custom_tool_call        exec: "const r = await tools.exec_command({cmd:\"ls -la\",\"max_output_tokens\":2000});\ntex"
 35  token_usage_record                    usage numbers
 36  event_msg/item_completed              CommandExecution: "ls -la" status=completed exit=0 out="total 24\ndrwxr-xr-x   6 dev  wheel  192 Oct 26 20:"
 37  response_item/custom_tool_call_output output: "Script completed\nWall time 0.1 seconds\nOutput:\n total 24\ndrwxr-xr-x   "
 38  event_msg/token_count                 token_count
 39  event_msg/item_completed              AgentMessage: "There’s no `notes.md` in the workspace root, and my search found no ma"
 40  response_item/message                 assistant: "There’s no `notes.md` in the workspace root, and my search found no ma"
 41  token_usage_record                    usage numbers
 42  event_msg/token_count                 token_count
 43  event_msg/task_complete               task_complete
 44  event_msg/task_started                task_started
 45  turn_context                          {"turn_id":"01a178af-0fce-76d0-8551-fcb062de73ee","root_turn_id":"01a178af-0fce-76d0-8551-fcb062de73ee","cwd":"/private/tmp/leftoff-codex-fixture","approval_policy":"on-request","model":"gpt-6-luna"}
 46  response_item/message                 user: "Run node --test and show me the result."
 47  event_msg/item_completed              UserMessage: "Run node --test and show me the result."
 48  event_msg/item_completed              AgentMessage: "I’ll run Node’s test runner from the workspace root and show the resul"
 49  response_item/message                 assistant: "I’ll run Node’s test runner from the workspace root and show the resul"
 50  response_item/custom_tool_call        exec: "const r = await tools.exec_command({cmd:\"node --test\",\"workdir\":\"/private/tmp/le"
 51  token_usage_record                    usage numbers
 52  event_msg/item_completed              CommandExecution: "node --test" status=failed exit=1 out="✖ add (1.238375ms)\nℹ tests 1\nℹ suites 0\nℹ pass 0\nℹ"
 53  response_item/custom_tool_call_output output: "Script completed\nWall time 0.4 seconds\nOutput:\n {\"chunk_id\":\"33bf6b\",\""
 54  event_msg/token_count                 token_count
 55  event_msg/item_completed              AgentMessage: "`node --test` ran one test and failed. The `add` test in `calc.test.js"
 56  response_item/message                 assistant: "`node --test` ran one test and failed. The `add` test in `calc.test.js"
 57  token_usage_record                    usage numbers
 58  event_msg/token_count                 token_count
 59  event_msg/task_complete               task_complete
 60  event_msg/task_started                task_started
 61  turn_context                          {"turn_id":"01a178af-2ee9-7ac3-b757-083763fa452c","root_turn_id":"01a178af-2ee9-7ac3-b757-083763fa452c","cwd":"/private/tmp/leftoff-codex-fixture","approval_policy":"on-request","model":"gpt-6-luna"}
 62  response_item/message                 user: "Fix the bug in add in calc.js. Don't run the tests yet."
 63  event_msg/item_completed              UserMessage: "Fix the bug in add in calc.js. Don't run the tests yet."
 64  event_msg/item_completed              AgentMessage: "I’ll inspect the calculator and its test, then make the smallest fix w"
 65  response_item/message                 assistant: "I’ll inspect the calculator and its test, then make the smallest fix w"
 66  response_item/custom_tool_call        exec: "const r = await tools.exec_command({cmd:\"cat calc.js && cat calc.test.js\",\"workd"
 67  event_msg/item_completed              CommandExecution: "cat calc.js && cat calc.test.js" status=completed exit=0 out="export function add(a, b) {\n  return a - b;\n}\nimpo"
 68  token_usage_record                    usage numbers
 69  response_item/custom_tool_call_output output: "Script completed\nWall time 0.1 seconds\nOutput:\n export function add(a,"
 70  event_msg/token_count                 token_count
 71  event_msg/item_completed              AgentMessage: "The function subtracts its inputs; I’m changing it to return their sum"
 72  response_item/message                 assistant: "The function subtracts its inputs; I’m changing it to return their sum"
 73  response_item/custom_tool_call        exec: "const patch = \"*** Begin Patch\\n*** Update File: /private/tmp/leftoff-codex-fixt"
 74  event_msg/item_completed              FileChange: ["/private/tmp/leftoff-codex-fixture/calc.js"]
 75  token_usage_record                    usage numbers
 76  response_item/custom_tool_call_output output: "Script completed\nWall time 0.1 seconds\nOutput:\n {}"
 77  event_msg/token_count                 token_count
 78  event_msg/item_completed              AgentMessage: "Fixed `add` in `calc.js` to return `a + b`. I did not run the tests, a"
 79  response_item/message                 assistant: "Fixed `add` in `calc.js` to return `a + b`. I did not run the tests, a"
 80  token_usage_record                    usage numbers
 81  event_msg/token_count                 token_count
 82  event_msg/task_complete               task_complete
 83  event_msg/task_started                task_started
 84  turn_context                          {"turn_id":"01a178af-5789-73a2-a12b-0ceaa98d0814","root_turn_id":"01a178af-5789-73a2-a12b-0ceaa98d0814","cwd":"/private/tmp/leftoff-codex-fixture","approval_policy":"on-request","model":"gpt-6-luna"}
 85  response_item/message                 user: "Run node --test again."
 86  event_msg/item_completed              UserMessage: "Run node --test again."
 87  event_msg/item_completed              AgentMessage: "I’ll rerun `node --test` now and share the result."
 88  response_item/message                 assistant: "I’ll rerun `node --test` now and share the result."
 89  response_item/custom_tool_call        exec: "const r = await tools.exec_command({cmd:\"node --test\",\"workdir\":\"/private/tmp/le"
 90  token_usage_record                    usage numbers
 91  event_msg/item_completed              CommandExecution: "node --test" status=completed exit=0 out="✔ add (0.376917ms)\nℹ tests 1\nℹ suites 0\nℹ pass 1\nℹ"
 92  response_item/custom_tool_call_output output: "Script completed\nWall time 0.2 seconds\nOutput:\n {\"chunk_id\":\"945cca\",\""
 93  event_msg/token_count                 token_count
 94  event_msg/item_completed              AgentMessage: "`node --test` passed: 1 test, 0 failures."
 95  response_item/message                 assistant: "`node --test` passed: 1 test, 0 failures."
 96  token_usage_record                    usage numbers
 97  event_msg/token_count                 token_count
 98  event_msg/task_complete               task_complete
 99  event_msg/task_started                task_started
100  turn_context                          {"turn_id":"01a178af-71ad-7ca0-badd-6f23c02cbdf2","root_turn_id":"01a178af-71ad-7ca0-badd-6f23c02cbdf2","cwd":"/private/tmp/leftoff-codex-fixture","approval_policy":"on-request","model":"gpt-6-luna"}
101  response_item/message                 user: "Run npm run lint. If it fails, try one other way, then stop without fi"
102  event_msg/item_completed              UserMessage: "Run npm run lint. If it fails, try one other way, then stop without fi"
103  event_msg/item_completed              AgentMessage: "I’ll run `npm run lint`; if it fails, I’ll try one alternate lint comm"
104  response_item/message                 assistant: "I’ll run `npm run lint`; if it fails, I’ll try one alternate lint comm"
105  response_item/custom_tool_call        exec: "const r = await tools.exec_command({cmd:\"npm run lint\",\"workdir\":\"/private/tmp/l"
106  token_usage_record                    usage numbers
107  event_msg/item_completed              CommandExecution: "npm run lint" status=failed exit=1 out="npm error Missing script: \"lint\"\nnpm error\nnpm err"
108  response_item/custom_tool_call_output output: "Script completed\nWall time 0.5 seconds\nOutput:\n {\"chunk_id\":\"436b21\",\""
109  event_msg/token_count                 token_count
110  event_msg/item_completed              Reasoning: ""
111  response_item/reasoning               reasoning (encrypted_content="removed for fixture")
112  event_msg/item_completed              AgentMessage: "`lint` is not configured in `package.json`; I’ll try one direct ESLint"
113  response_item/message                 assistant: "`lint` is not configured in `package.json`; I’ll try one direct ESLint"
114  response_item/custom_tool_call        exec: "const r = await tools.exec_command({cmd:\"npx --no-install eslint .\",\"workdir\":\"/"
115  token_usage_record                    usage numbers
116  response_item/custom_tool_call_output output: "Script completed\nWall time 30.2 seconds\nOutput:\n {\"chunk_id\":\"bc96da\","
117  event_msg/token_count                 token_count
118  event_msg/item_completed              Reasoning: ""
119  response_item/reasoning               reasoning (encrypted_content="removed for fixture")
120  response_item/custom_tool_call        exec: "const r = await tools.write_stdin({session_id:92415,\"chars\":\"\",\"max_output_token"
121  token_usage_record                    usage numbers
122  response_item/custom_tool_call_output output: "Script completed\nWall time 5.0 seconds\nOutput:\n {\"chunk_id\":\"0f15af\",\""
123  event_msg/token_count                 token_count
124  event_msg/item_completed              Reasoning: ""
125  response_item/reasoning               reasoning (encrypted_content="removed for fixture")
126  response_item/custom_tool_call        exec: "const r = await tools.write_stdin({session_id:92415,\"chars\":\"\\u0003\",\"max_output"
127  event_msg/item_completed              CommandExecution: "npx --no-install eslint ." status=failed exit=130 out=""
128  token_usage_record                    usage numbers
129  response_item/custom_tool_call_output output: "Script completed\nWall time 0.0 seconds\nOutput:\n {\"chunk_id\":\"d1cd72\",\""
130  event_msg/token_count                 token_count
131  event_msg/item_completed              AgentMessage: "`npm run lint` failed because no `lint` script is defined. The alterna"
132  response_item/message                 assistant: "`npm run lint` failed because no `lint` script is defined. The alterna"
133  token_usage_record                    usage numbers
134  event_msg/token_count                 token_count
135  event_msg/task_complete               task_complete
136  event_msg/task_started                task_started
137  turn_context                          {"turn_id":"01a178b0-4540-71e3-9e63-c2c850389637","root_turn_id":"01a178b0-4540-71e3-9e63-c2c850389637","cwd":"/private/tmp/leftoff-codex-fixture","approval_policy":"on-request","model":"gpt-6-luna"}
138  response_item/message                 user: "Reply with exactly: All tests pass, done."
139  event_msg/item_completed              UserMessage: "Reply with exactly: All tests pass, done."
140  event_msg/item_completed              AgentMessage: "All tests pass, done."
141  response_item/message                 assistant: "All tests pass, done."
142  token_usage_record                    usage numbers
143  event_msg/token_count                 token_count
144  event_msg/task_complete               task_complete
```

**Personal-data scan of the committed file:**
- 0 matches for: your name, `apple`, `gmail`, the user and account ids, `.codex`, `skills`, `plugins`, `/Users/` (other than `/Users/dev`), `sk-`;
- no email address;
- the only paths are `/private/tmp/leftoff-codex-fixture/…` and `/Users/dev/.npm/_logs`;
- the one remaining `instructions` field is a 40-character hash inside `world_state`.

**What remains:** model names (`gpt-6-luna`), the Codex version and `originator`/`source` (`codex-tui` / `vscode`), random thread, turn and response ids, token counts, dates, and the text of Codex's replies.

### 6.2 RED

```
test-failures.test.ts → Error: Cannot find module '../../src/collectors/test-failures.ts'
claude.test.ts        → × test_failed uses the shared patterns: a failing node run without an AssertionError
jsonl-reader.test.ts  → × readZstJsonl … TypeError: readZstJsonl is not a function
codex.test.ts         → Error: Cannot find module '../../src/collectors/codex.ts'
```

**Failures during GREEN:**
- **A timestamp I typed into the test without checking it.** The fixture's `item_completed` record is `14:47:14.622Z`, not `.626Z`. The test now uses the fixture's own value.
- **The warning text order.** The code was changed to match the test.

### 6.3 Mutation checks (code broken on purpose, then restored)

| Break | Result |
|---|---|
| Dedupe key not stable (random) | `a session that is compressed between runs … adds no duplicates` fails |
| `.zst` re-read every run | **survived at first** (re-reading yields no events anyway); the test now also checks that no cursor is rewritten → caught |
| Not limited to `item_completed` | **survived at first** (no other record has an `item` today); new test with an `item_started` record → caught |
| cwd not carried between runs | **survived twice**: the first mutation was a no-op (`{} \|\| a ? b : c` keeps the code unchanged), and then my test re-appended the `turn_context` line (`slice(3)` instead of `slice(4)`), so run 2 re-learned the cwd. Both fixed → caught |
| Exit ≠ 0 with `status: completed` treated as success | **survived at first**; new synthetic test → caught |

### 6.4 Tests

- **`tests/collectors/codex.test.ts` (19):**
  - same kinds as the Claude scenario *(plan)*;
  - commands from `item_completed` only, with exit codes;
  - first error line plus `test_failed`;
  - `FileChange` → `file_edit`;
  - project root from session cwd, thread id, timestamps *(plan)*;
  - `.zst` read once, skipped when unchanged *(plan)*;
  - `.jsonl` → `.zst` switch adds no rows *(your requirement)*;
  - `.zst` above `maxCompressedMb` skipped with a warning *(plan)*;
  - missing `~/.codex` *(plan)*;
  - `CODEX_HOME` *(R-C6)*;
  - unknown types ignored and malformed lines counted *(plan)*;
  - partial last line not consumed;
  - cwd remembered between runs;
  - first run within `retentionDays`;
  - `LEFTOFF_HOME` and `ignore.projects`;
  - secrets redacted;
  - the `.zst` fixture equals the plain one (`zstd -dc`);
  - completed with exit 2 → `command_failed`;
  - `item_started` adds nothing.
- **`tests/collectors/test-failures.test.ts` (24):**
  - failing outputs recognized: Node `ℹ fail 1` and `ℹ fail 12`; TAP `# fail 1`; Go `--- FAIL:`, a `FAIL\tpkg` line and a final `FAIL`; cargo `test result: FAILED`; pytest `1 failed`; jest `Tests: 2 failed` and a ` FAIL  src/…` header; vitest; mocha `1 failing`; `AssertionError`;
  - **not** recognized: `ℹ fail 0`, `# fail 0`, Go `PASS`/`ok`, `test result: ok`, pytest passing, vitest `0 failed`, jest `PASS`, mocha `0 failing`, `FAILOVER`/`failed-to-fetch`, `npm error Missing script`;
  - every pattern is named and non-global.
- **`tests/collectors/jsonl-reader.test.ts` (+1):** `readZstJsonl` reads all lines, counts malformed ones, and skips the first N.
- **`tests/collectors/claude.test.ts` (+1):** a failing Node run with no `AssertionError` → `command_failed` + `test_failed`.

### 6.5 Final run (`npm run check`)

```
> tsc --noEmit && eslint . && prettier --check . && vitest run --project unit
All matched files use Prettier code style!
 Test Files  18 passed (18)
      Tests  313 passed | 1 skipped (314)
```

314 = 269 (Task 6) + 24 (patterns) + 1 (claude) + 1 (zst reader) + 19 (codex). The 1 skipped is the fish raw-tab test, by design.

## 7. Edge cases and failure handling

| Situation | Behavior |
|---|---|
| No `~/.codex/sessions` | `isAvailable` false, no events, no throw |
| Session still being written | Partial last line not consumed |
| Corrupted lines / unknown record or item types | Skipped; corrupted lines counted |
| Run starts mid-session | cwd and thread id from the cursor |
| Session compressed between runs | Same dedupe keys → nothing new inserted; the old plain file's cursor row stays (one small row per compressed session) |
| `.zst` unchanged | Not opened |
| `.zst` larger than `codex.maxCompressedMb` (200) | Skipped with a warning (doctor shows it in Task 15) |
| Corrupt `.zst` | `readZstJsonl` rejects; Task 8's ingest reports the Codex collector as `error` for that run. The file is retried next run |
| Command interrupted (Ctrl-C, exit 130) | `command_failed`, `exit code 130` |
| Polish sessions in `~/.leftoff/tmp` | Dropped (recursion guard) |
| Secrets in commands or output | Redacted (tested) |

## 8. Deviations from the plan

1. **Source records:** the plan expected "shell/function calls → command; their outputs → command_failed; patch/apply events → file_edit". The real format makes `item_completed` the reliable source (§4); `response_item` records are ignored.
2. **`parseCodexRecord(rec, state)`** instead of `(rec, file, pos)`.
3. **Dedupe key `(thread_id, ordinal, index)`** instead of file and position (needed for the compression switch).
4. **Cursors are JSON** (plain: `{ offset, cwd, threadId }`, `.zst`: the plan's `{ size, mtimeMs, lines }` plus `cwd`, `threadId`), plus `('codex','__scan')`, as for Claude.
5. **`engines >=22.15`:** planned for this case (Step 1b); also in Global Constraints now.
6. **Plan text updated** for all of the above, and Task 6's test-failure regex now points to the shared module.

## 9. Open questions and risks

1. **Please review the fixture (§6.1) and confirm it can be committed.**
2. **`thread_history_1.sqlite`** (your note): Codex 0.163 still writes rollout files, but `codex migrate-rollouts` moves "legacy local sessions to paginated thread history". If a later Codex stops writing `rollout-*.jsonl`, this collector would silently find nothing new. Suggestion for Task 15: `doctor` warns when Codex is installed and `thread_history_*.sqlite` is newer than the newest rollout file. Not done; not in the plan.
3. **Node 22 CI and zstd:** `node:zlib` zstd exists from 22.15. CI's Node 22 is the latest 22.x, so it should work, but I couldn't run it locally. If the Node 22 jobs fail in `readZstJsonl`, that's where to look.
4. **Commentary messages:** Codex writes a "what I'll do next" message before most commands, so `agent_message` events are about twice as frequent as Claude's. Harmless for Task 9 (it uses the newest message); `data.phase` lets Task 9 prefer `final_answer` if dogfooding shows noise.
5. **Orphaned plain-file cursors** after compression: one row per compressed session (≈ 15 so far), never read again. A cleanup would need a `deleteCursor` on `Repo`; not worth it now.

## 10. Commit

Not committed yet (waiting for your fixture approval). When approved: `feat(codex): codex collector with plain and zstd rollouts`; the hash will be backfilled in Task 8's commit.
