# Task 15d: Readable details and dogfood fixes

Inserted during Task 17, after your dynavec test. It covers the four items left over from 15c (A1–A4) and your new findings (B5–B8). All test-first; nothing in the code refers to your projects. Commits `8a8d80b` and the follow-up fix commit, not pushed. Part 1 (the CI fix) was `2421929`, which you confirmed green.

## 1. What changed

| # | Change |
|---|---|
| A1 | Large briefs: `• 28 commits, the newest:`, then up to 3 subjects, one per line. A single commit stays on its line (`• 1 commit: …`). A rich large brief can now reach 14 lines (§9.2). |
| A2 | Without commits, the README says what the project is: "You were working on <project> (<one-liner>): mostly <folders>". The one-liner is the first heading. When the heading is just the project's name, it is the first sentence of the first paragraph instead, with "<name> is" dropped. Badges, images, HTML and code fences are skipped; it is cut at a word near 80 characters. The order is branch → commits → README → request → folders. |
| A3 | One-time, on your DB, with a backup first (`~/.leftoff/leftoff-before-files-backfill.db`, mode 600). File lists filled in for 59 commits inside the work windows: leftoff 4, LoopLint 28, hackerrank-orchestrate-october26 27. LoopLint's "Most changes in" now counts 72 files (22 before). |
| A4 | Your home folder and `/` get no auto brief, and never appear in loose ends. |
| B5 | leftoff never records or counts its own commands: `leftoff …`, the shim, or `node …/leftoff/dist/cli.js`, also inside a `cd … &&` chain. The shell collector drops them, and the brief ignores those stored before. Your `leftoff resume--details` typo is gone from dynavec. |
| B6 | "Last worked" is the last real work. Look-around commands after it don't move it: probes, scratch, read-only git (`status`, `log`, `diff`, …), `cd`, `clear`, and leftoff itself. A real command such as `npm run build` does move it. |
| B7 | A quote is a complete sentence that fits, or nothing. A cut claim reads "Codex said it was done, but …". The agent's last update shows whole sentences that fit, or no line at all. |
| B8 | `leftoff resume --details` is rewritten in plain words (§2). The old section-style terminal brief, its tests and its golden are removed. Sources and every raw field are in `--json` only. |

Also from 15c (committed in `744849d`):
- a topic under 3 words gets the newest commit subject;
- stopped servers (exit 130/137/143) are not problems;
- exit 127 from your own shell is a typo.

## 2. The new `--details`

1. The header line.
2. "You were …".
3. A line saying how many things are still not right. It includes the agent's claim when there is one; if the quote doesn't fit, the line says "<Agent> said it was done." instead.
4. One numbered block per problem. Problems that read the same ("Ruff finds unformatted files") are merged into one block. Each block has:
   - what is wrong, in words;
   - `Error:` — left out when the words already say it, or when the error is just "failed" or "exit code N";
   - `Command:` or `Commands:`;
   - `Files:` (the commands' file arguments);
   - `Already tried:` in words: "editing exceptions.py", "running the reset tests", "reading a.ts", "searching the code", "checking the diff". Raw look-arounds, git chores, temp-folder commands and one-off scripts are left out.
5. `Uncommitted:` when there are uncommitted files, `What changed:`, any notes, and `Next:`.

## 3. Tests

**RED first** for every rule. Exceptions:
- **The shell collector's skip** was written together with the facts filter. Its test came after, and I proved it by removing the line: the test then fails.
- **Expectations I corrected:**
  - "the errors tests" for `test_errors.py` (an existing naming rule);
  - an update test where two sentences do fit in 100 columns;
  - a regex that matched "Already tried:".
- **One judgment against your target example:** I first dropped all look-arounds from "Already tried". Your example lists "reading the s3vectors tests, checking the diff", so worded look-arounds stay and only raw ones go.

**Mutation pass.** 8 mutations: the own-command filter, the activity rule, cut sentences, cut quotes, code fences in READMEs, the README topic, the home-folder skip, and the redundant error line. All 8 were caught.

**Results**
- `npm run check`: 1042 passed, 1 skipped.
- `npm run test:e2e`: 20 passed.

## 5. Your real output (after the fixes)

```
$ cd ~/dynavec && leftoff resume
dynavec · last worked 11d ago · about 15 min · branch fix/issue-15-s3vectors-error-mapping
  You were fixing s3vectors error mapping (issue 15).
  Codex said it was done, but `make run-ci` still fails.
  Next: Get `make run-ci` working (ERROR collecting tests/test_semantic_kernel.py).

$ cd ~/dynavec && leftoff resume --details
dynavec · last worked 11d ago · about 15 min · branch fix/issue-15-s3vectors-error-mapping
  You were fixing s3vectors error mapping (issue 15).
  Codex said it was done. 2 things are still not right:

  1. `make run-ci` fails
     Error: ERROR collecting tests/test_semantic_kernel.py
     Command: make run-ci

  2. Ruff finds unformatted files
     Error: unformatted: File would be reformatted
     Commands: uv run --no-sync ruff format --check src/dynavec/exceptions.py src/dynavec/__init__.…
     Files: src/dynavec/__init__.py, src/dynavec/exceptions.py, src/dynavec/stores/_s3vectors_error…
     Already tried: running the async_s3vectors, list_vectors and other tests, editing…

  What changed: 6 files, most in src/dynavec and tests
  Next: Get `make run-ci` working (ERROR collecting tests/test_semantic_kernel.py).

$ cd ~/LoopLint && leftoff resume
LoopLint · last worked 8d ago · about 4.5 hours · branch feat/m0-m1
  You were working on semantic, kb and adapters.
  What got done
    • 28 commits, the newest:
        unique keys, project-owned names, plain-function tools
        subscripted callees, public has_module
        prefix qnames are known, plain_functions_are_tools
    • Most changes in crates/looplint_semantic, crates/looplint_adapters and… (72 files)
  Where it stopped
    • Claude said it was done, but the looplint_adapters tests are still failing.
    • the Rust tests are failing
    • the looplint_semantic tests are failing (and 2 more problems)
  Next: Make the looplint_adapters tests pass (`cargo test -p looplint_adapters`).

$ cd ~/LoopLint && leftoff resume --details
LoopLint · last worked 8d ago · about 4.5 hours · branch feat/m0-m1
  You were working on semantic, kb and adapters.
  Claude said it was done. 3 things are still not right:

  1. The looplint_adapters tests are failing
     Commands: cargo test -p looplint_adapters; cargo test -p looplint_adapters --test…
     Already tried: searching the code, reading 2026-10-24-looplint-m0-m1.md, reading files

  2. The Rust tests are failing
     Command: cargo fmt --all && cargo clippy --all-targets -- -D warnings | tail -3; cargo test…
     Already tried: running the looplint_kb tests, searching the code, reading files

  3. The looplint_semantic tests are failing
     Command: cargo test -p looplint_semantic --test dataflow | grep -vE "\.\.\. ok$"
     Already tried: searching the code, reading files

  What changed: 28 commits, the newest "unique keys, project-owned names, plain-function tools"…
  Next: Make the looplint_adapters tests pass (`cargo test -p looplint_adapters`).

$ leftoff
Loose ends across 5 projects

Orbit10 (main) · last worked 9d ago · Codex said done, 9 problems still failing · stale
  You were working on Orbit10 (an original, Apache-2.0 local workspace for humans and coding…
  Next: Make the tests pass (also: 4 more problems, 23 uncommitted files)
LoopLint (feat/m0-m1) · last worked 8d ago · Claude said done, 5 tests still failing
  You were working on semantic, kb and adapters.
  Next: Make the looplint_adapters tests pass (`cargo test -p looplint_adapters`).
dynavec (fix/issue-15-s3vectors… · last worked 11d ago · Codex said done, 3 problems still failing
  You were fixing s3vectors error mapping (issue 15).
  Next: Get `make run-ci` working (ERROR collecting tests/test_semantic_kernel.py).
leftoff (main) · last worked 1m ago · Claude said done, 2 tests still failing · 2 uncommitted files
  You were working on brief: relax perf budgets on CI runners, add a job timeout.
  Next: Make the render tests pass (`npx vitest run --project unit tests/render`).
hackerrank-orchestrate-october2… · last worked 6d ago · Claude said done, 2 uncommitted files ·…
  You were working on: Add playbook.
  Next: Commit the 2 files Claude said were committed.
```
The leftoff entry is this session while it was still running.

## 9. What I can see is still weak (for your judgment)

1. **Counts disagree.** For dynavec, `--details` says "2 things" (problems that read the same are merged) while `leftoff` says "3 problems". LoopLint shows the same split (3 vs 5). Should loose ends count the merged problems too?
2. **Line count.** Large briefs with 3 commit lines can reach 14 lines, above the ~12 target.
3. **Some "Already tried" items are thin:** "reading files", "reading 2026-10-24-looplint-m0-m1.md".
4. **Long commands and file lists** in `--details` are cut at 100 columns. Wrapping them onto more lines would show them whole.
5. **Orbit10's next step is vague** ("Make the tests pass"). Its failing command has no file or package to name the tests by.
