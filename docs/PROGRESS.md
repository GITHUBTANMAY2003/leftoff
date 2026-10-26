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
| 4 | Shell hook scripts and shell collector ([report](reports/task-04.md)) | done | `8476acf` | One JSON-map cursor row instead of one per `*.ingesting` file (approved); bash duration `-1` on all versions (approved); rotated name `shell.log.<ms>.<pid>.ingesting`; abandoned partial lines dropped after 60 s instead of appended back. CI was red: fish tests needed a pty (fixed in Task 5). Fold-ins: mysql/sshpass redaction; plan text |
| 5 | Git collector ([report](reports/task-05.md)) | done | `166ee39` | Git cursor is JSON `{ commit, reflogAt, reflogKeys }`; `<cursor>..HEAD` bounded by `retentionDays`; `git diff --shortstat HEAD`; no `symbolic-ref` call. Also: fish tests run under a pty (`script`); redaction fix for in-word `-name` "flags" (found by the §1.1 names) |
| 6 | Incremental JSONL reader and Claude Code collector ([report](reports/task-06.md)) | done | (filled in by Task 7) | Claude cursor JSON `{ offset, toolUses }` plus a `__scan` cursor; tool events emitted at result time; `test_failed` only for failed results; no session_start/end from transcripts (hooks do it). Fold-ins: only your own commits (author email per repo, no merges); shared ignore module |
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

**Task 7: Codex CLI collector.** Needs a real Codex session from the owner.
