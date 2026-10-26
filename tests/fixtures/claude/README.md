# Claude Code transcript fixtures

Captured 2026-10-26 with **Claude Code 2.1.310** (`version` field in every record),
model `claude-opus-5-5`, on macOS, by the project owner. The scenario ran in a scratch
git repo at `/private/tmp/leftoff-fixture` (`calc.js` with a bug, `calc.test.js` using
`node:test`). Prompts, in order:

1. `Run ls /nope and tell me what happened.` — failing Bash
2. `Read the file notes.md.` — failing non-Bash tool (Read)
3. `Run node --test and show me the result.` — failing test run
4. `Fix the bug in add in calc.js with the Edit tool. Don't run the tests yet.` — Edit
5. `Run node --test again.` — successful Bash
6. `Run npm run lint. If it fails, try one other way, then stop without fixing anything.` —
   abandoned retry (`npm run lint`, then `npx --no-install eslint .`, both fail)
7. `Reply with exactly: All tests pass, done.` — a "done" claim (Task 9)

## Files

| File | Content |
|---|---|
| `session-basic.jsonl` | The sanitized transcript (95 records) |
| `session-malformed.jsonl` | `session-basic` plus 2 corrupted lines, 1 record of an unknown `type`, 1 assistant record with an unknown content block type |
| `session-partial.jsonl` | `session-basic` with its last line cut in half (as if still being written) |

## How `session-basic.jsonl` was sanitized

The original file was `~/.claude/projects/-private-tmp-leftoff-fixture/<session>.jsonl`
(185 records). Only that file was copied (owner-approved). Then:

1. Kept records 1–155 only: the owner's two extra turns at the end (a mistyped `/exit`
   and an `ls` of `~/.claude/projects`) and the session-end records after them were removed.
2. Removed every `api-request-shape` and `api-request` record and the system/user
   `api-request-blob` records: copies of the full API request (system prompt, the
   owner's environment, plugin list, email). **Kept** the 5 assistant `api-request-blob`
   records: they repeat a tool call with the **same tool-use id** as the real `assistant`
   record (with a rewritten command), which the collector must ignore.
3. Removed all `attachment` records except `date` and `model` (the rest listed the
   owner's skills, plugins, MCP servers and environment).
4. Replaced `thinking` text and signatures, `serverClassifierContext`, and the stop-hook
   command (a plugin path) with placeholders.
5. Replaced the owner's name, email and home folder (`/Users/<name>` → `/Users/dev`).

A scan afterwards found no email address and no path outside `/private/tmp/leftoff-fixture`
and `/Users/dev/.npm/_logs/…`.

## Record shapes the collector relies on (Claude Code 2.1.310)

- Every message record has `type` (`user` | `assistant`), `timestamp` (ISO), `cwd`,
  `sessionId`, `uuid`, `isSidechain`, and `message.content`.
- User prompt: `type: "user"`, `message.content` is a **string**.
- Tool call: `type: "assistant"`, content block `{ type: "tool_use", id, name, input }`;
  Bash `input.command`; Edit/Write `input.file_path`.
- Tool result: `type: "user"`, content block `{ type: "tool_result", tool_use_id,
  content, is_error }`. The record's `toolUseResult` is a **string** for errors
  (`"Error: Exit code 1\n…"`) and an object for successes (`{ stdout, stderr, … }` for
  Bash; `{ filePath, oldString, newString, … }` for Edit). The command is **not** in
  the result: it must be taken from the matching `tool_use`.
- Assistant text: content block `{ type: "text", text }`; `thinking` blocks are ignored.
- Other record types (`attachment`, `mode`, `permission-mode`, `ai-title`,
  `file-history-snapshot`, `system`, `cost-state`, `api-request*`, …) carry no events.

## Hook stdin fields (from https://code.claude.com/docs/en/hooks)

Every hook receives JSON on stdin with `session_id`, `transcript_path`, `cwd`,
`hook_event_name` (plus `permission_mode`, `effort`, `prompt_id`, and others leftoff
doesn't use). `SessionStart` adds `source` (`startup` | `resume` | `clear` | `compact` |
`fork`) and optionally `model`; `SessionEnd`'s reason/matcher values are `clear`,
`resume`, `logout`, `prompt_input_exit`, `other`. Task 13 verifies them in a real session.
