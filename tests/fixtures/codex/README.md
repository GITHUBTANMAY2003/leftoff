# Codex CLI session fixtures

Captured 2026-10-26 with **codex-cli 0.163.0** (`cli_version` in `session_meta`), model
`gpt-6-luna`, `originator: codex-tui`, on macOS, by the project owner. The scenario ran in a
scratch git repo at `/private/tmp/leftoff-codex-fixture` (`calc.js` with a bug,
`calc.test.js` using `node:test`). Prompts, in order:

1. `Run ls /nope and tell me what happened.`
2. `Show me the contents of notes.md.` (Codex searched with `rg`, which exits 1, then `ls -la`)
3. `Run node --test and show me the result.` (failing test)
4. `Fix the bug in add in calc.js. Don't run the tests yet.` (`cat`, then `apply_patch`)
5. `Run node --test again.` (passes)
6. `Run npm run lint. If it fails, try one other way, then stop without fixing anything.`
   (`npm run lint` fails; `npx --no-install eslint .` hangs and is interrupted, exit 130)
7. `Reply with exactly: All tests pass, done.`

## Files

| File | Content |
|---|---|
| `session-basic.jsonl` | The sanitized session (144 records) |
| `session-basic.jsonl.zst` | `session-basic.jsonl` compressed with the `zstd` CLI (`zstd -q -19`), as Codex does to older sessions |
| `session-malformed.jsonl` | basic + 2 corrupted lines + 1 unknown record `type` + 1 `item_completed` with an unknown item type |
| `session-partial.jsonl` | basic with its last line cut in half |

## How `session-basic.jsonl` was sanitized

The original was `~/.codex/sessions/2026/10/26/rollout-2026-10-26T20-15-50-<id>.jsonl`
(165 records). Only that file was copied (owner-approved); nothing else from `~/.codex`
was read. Then:

1. Removed records 2–13: the first turn, which failed with "model not supported with a
   ChatGPT account".
2. `session_meta`: kept only `id`, `session_id`, `timestamp`, `cwd`,
   `runtime_workspace_roots`, `originator`, `cli_version`, `source`, `thread_source`,
   `model_provider`, `history_mode`, `git`. Removed the user and account ids and the 21 KB
   `base_instructions` (Codex's system instructions, listing skill and plugin paths).
3. Removed every developer message, every `<environment_context>` user message, and every
   `thread_settings_applied` event (instructions and sandbox settings).
4. `turn_context`: kept only `turn_id`, `root_turn_id`, `cwd`, `approval_policy`, `model`.
5. Replaced `encrypted_content` of `reasoning` records with a placeholder.
6. Replaced the owner's home folder (`/Users/<name>` → `/Users/dev`, from an npm error path).

A scan afterwards found no email address, no account id, no `.codex`, skill or plugin path,
and no path outside `/private/tmp/leftoff-codex-fixture` and `/Users/dev/.npm/_logs`.

## Record shapes the collector relies on (codex-cli 0.163.0)

Each line is `{ timestamp, ordinal, type, payload }`. `ordinal` is unique and increasing
within a session.

- `session_meta`: `payload.id` (the thread id) and `payload.cwd`.
- `turn_context`: `payload.cwd` for the turn.
- **`event_msg` with `payload.type: "item_completed"`** carries one finished item and the
  `thread_id`; this is the only source of events:
  - `UserMessage`: `item.content[].text` (type `text`)
  - `AgentMessage`: `item.content[].text` (type `Text`), `item.phase` (`commentary` |
    `final_answer`)
  - `CommandExecution`: `item.command` (e.g. `["/bin/zsh", "-lc", "ls /nope"]`),
    `item.cwd` (a `file://` URL), `item.status` (`completed` | `failed`), `item.exit_code`,
    `item.aggregated_output`
  - `FileChange`: `item.changes` (object keyed by absolute path; `type` `update` | `add` |
    `delete`), `item.status`
  - `Reasoning` and unknown item types: no event
- `response_item` records (`message`, `custom_tool_call` whose input is a JavaScript snippet
  calling `tools.exec_command(...)` or `tools.apply_patch(...)`, `custom_tool_call_output`,
  `reasoning`) **repeat** what `item_completed` says, so they are ignored.
- Other types (`world_state`, `token_usage_record`, `event_msg` `task_started` /
  `task_complete` / `token_count`) carry no events.

## Related files in `~/.codex` that leftoff does not read

`thread_history_1.sqlite` ("paginated thread history", see `codex migrate-rollouts`) may
replace rollout files in a future Codex version. The collector only reads
`sessions/**/rollout-*.jsonl` and `rollout-*.jsonl.zst`.
