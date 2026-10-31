# Task 17: Dogfooding and hardening (in progress)

This is the first commit of Task 17. It adds your answers after Task 16 and the two dogfood documents. Then the work stops until you've used leftoff for a week. Not pushed.

## 1. Your answers after Task 16

1. **Shell scripts:** you refresh them with `leftoff setup`. Your shell log shows you ran `setup` last night (19:10 UTC), and the installed copies (written by that run) contain the quiet-marker check (checked with `grep`), so the cheap `cd` is active. Note that `doctor`'s "Shell scripts — version 0.0.1" can't tell an old copy from a new one, because every build has version 0.0.1 (§9.3).
2. **You stopping your own command is not a problem** (test-first). Exit 129 (hangup), 130 (Ctrl-C) and 143 (terminate) from your shell are now ignored, and the rule is applied when reading, so older events follow it too. An agent's command that ends the same way still counts: the test pins both directions. On your real data, `MyVoice-Enhanced` (the `afplay` loop you stopped) is gone from loose ends.
3. **The brief-timing delay:** kept as built.
4. **The backup** `~/.leftoff/leftoff-before-claude-reread.db` is mode 600 (checked: `-rw-------`). Deleting it is now Task 17 Step 7 in the plan and item 10 of the checklist.

## 2. Dogfood documents

- **`docs/dogfood-log.md`:** a template entry (date, project, time away, the yes/no question "did the brief correctly tell me where I left off and what to do next?", what was wrong, the brief as shown, Fixed), plus a table for beta testers' ratings.
- **`docs/dogfood-checklist.md`:**
  - **daily:** `leftoff doctor`, the error log, `resume` and `leftoff` timings against the §1.12 budgets, the secret scan, and rating one brief;
  - **weekly:** the probe and scratch reviews;
  - **once:** the warm Ollama polish test, and an uninstall + reinstall;
  - **at the end:** delete the backup.

## 3. Tests

- **RED:** 3 cases (exit 129/130/143) failed first.
- **Results:** `npm run check` passes (952 passed, 1 skipped). `npm run test:e2e` passes (18). `dist/` is rebuilt.

## 9. Questions for you

1. **`npm link` (Step 1).** It makes `leftoff` a normal command that runs this repo's `dist/cli.js`. It writes a symlink into npm's global folder (`npm prefix -g`), outside the repo, so I'm waiting for your yes.
2. **First dogfood finding** (logged): your home folder is listed as a project, `apple · 4m ago`, with `` `cd~/leftoff` — exit code 127 ``. That was a typo; you ran `cd ~/leftoff` right after. Two decisions:
   - (a) Should your home folder ever be a loose end? I'd leave it out: it isn't a project.
   - (b) Should a "command not found" (127) from your own shell count as a problem? I'd ignore it only when the "command" isn't a real program name (`cd~/leftoff`). A real missing tool, such as `pnpm: command not found`, would still count.
3. **`doctor` can't see stale shell scripts during dogfooding.** The scripts are stamped with the package version, which stays 0.0.1 across rebuilds. I suggest stamping them with a hash of their content so `doctor` warns after a rebuild until `setup` runs again. Do it?

## 4. Observed while checking (no action yet)

`leftoff doctor` on your machine: 0 problems, 1 warning ("Recent errors"). The log lines behind it are:
- `user.email is not set` notes, one per repo;
- one of those came from a debug folder of mine during Task 16 (`.e2e-tmp/dbg-…`, since removed);
- one background `claude -p` polish that timed out after 60 s (Oct 31, 09:00 UTC).

If polish timeouts repeat during the week, log them.

## 5. Step 1: `npm link` (owner-approved, 2026-11-01)

- `npm run build && npm link`. `leftoff` is now `/opt/homebrew/bin/leftoff`, a symlink to this repo's `dist/cli.js`; `leftoff --version` prints `0.0.1`. Nothing else outside the repo changed.
- **Timings with the linked command, on your real data:**
  - `leftoff resume` in `~/leftoff`: 360–460 ms over 5 runs.
  - `leftoff` (loose ends): 0.75 s, within the 1.5 s budget.
- The `resume` numbers are not a clean "no new data" measurement: this Claude session writes to its transcript between runs, so every run had something new to read. The clean measurement is the checklist's daily item 3, run when no agent is working. If it is still over 300 ms there, log it and I'll profile it.
- **Second finding** (logged): after a short reply such as "Yes, run npm link", the next step reads `Continue: Yes, run npm link`. Worth checking after a real break before deciding on a fix.
