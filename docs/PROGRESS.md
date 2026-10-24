# leftoff — Progress

Source plan: [leftoff-implementation-plan.md](leftoff-implementation-plan.md). Reports live in [reports/](reports/).

Status values: `not started` · `in progress` · `done` · `blocked` · `deferred`.
The commit hash for each task is filled in by the next task's commit (plan review B11).

| # | Task | Status | Commit | Deviations from plan |
|---|---|---|---|---|
| 0 | Plan review ([report](reports/task-00-plan-review.md)) | done | `76e3c17` | — (decisions applied to the plan in `11c35e4`) |
| 1 | Project scaffold, paths, config, logger ([report](reports/task-01.md)) | done | `f52dd1e` | None in scope. Clarifications: 25 tests beyond the plan's list; `setConfigValue` also saves; `package.json` gets `description` and `license` early |
| 2 | SQLite store and repository ([report](reports/task-02.md)) | done | `5a475af` | `ON CONFLICT(dedupe_key) DO NOTHING` instead of `INSERT OR IGNORE` (which hid NOT NULL errors); WAL switch retried on SQLITE_BUSY (race found by tests); owner-requested integer rule for count config keys folded in |
| 3 | Event model, redaction, project resolution ([report](reports/task-03.md)) | done | `017b1d1` | `pass`/`auth` match only as name segments (avoids redacting `--author`, `passport`) — confirmed by owner; `redactDeep` also redacts values under secret-named keys. Fold-ins: unreadable event rows skipped; plan text lines |
| 4 | Shell hook scripts and shell collector ([report](reports/task-04.md)) | done | (filled in by Task 5) | One JSON-map cursor row instead of one per `*.ingesting` file (awaiting owner); bash duration `-1` on all versions (awaiting owner); rotated name `shell.log.<ms>.<pid>.ingesting`; abandoned partial lines dropped after 60 s instead of appended back. fish script untested locally (CI only). Fold-ins: mysql/sshpass redaction; plan text |
| 5 | Git collector | not started | | |
| 6 | Incremental JSONL reader and Claude Code collector | not started | | |
| 7 | Codex CLI collector | not started | | |
| 8 | Ingest orchestrator | not started | | |
| 9 | Work sessions and brief facts | not started | | |
| 10 | Renderers, `resume` and `note` commands | not started | | |
| 11 | Standup and loose-ends commands | not started | | |
| 12 | AI polish providers and background summarize | not started | | |
| 13 | Claude Code plugin and hook commands | not started | | |
| 14 | Auto brief on terminal open | not started | | |
| 15 | setup, doctor, status, forget, config, uninstall | not started | | |
| 16 | End-to-end and performance tests | not started | | |
| 17 | Dogfooding and hardening | not started | | |
| 18 | Packaging, docs and release | not started | | |

## Next task

**Task 5: Git collector.** Waiting for the owner's `continue`, the answers to Task 4 report §8.1 (cursor map) and §8.2 (bash duration), and the CI result for the fish tests.
