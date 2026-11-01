# Task 15e: One count, words for errors, concrete next steps

These are your seven points after 15d, all generic and test-first. Commit `54597a1` (plus this report), not pushed.

## 1. What changed

| # | Change |
|---|---|
| 1 | **False alarm fixed.** A whole-project check inside a successful chain now counts as passed: `npx prettier …; npm run check \| grep …` and `… && cargo test --workspace`. `npm/pnpm/yarn run ci` and `make ci`/`run-ci` are check suites, alongside the `test` and `check` ones. On your data, leftoff itself shows nothing failing. LoopLint does too: its "5 tests still failing" was the same kind of false alarm. On Oct 24 at 07:16, Claude ran `cargo fmt --check && … && cargo test --workspace` as one `&&` chain, it passed, and the commit came right after. |
| 2 | **One count everywhere.** `src/brief/groups.ts` is the only grouping, used by `leftoff`, `resume` and `--details`. dynavec reads "2 problems open" in `leftoff` and "2 things are still not right" in `--details`. |
| 3 | **Merged test failures.** A project's test failures are one sentence: "Tests fail in 2 packages: a and b", or suites for test files. A whole-suite run isn't named when packages already explain it. Formatting failures are one group that counts the files ("6 files need formatting"). Sentences start with a capital letter. |
| 4 | **Headers are never cut.** A brief or `--details` header that's too long first drops the time estimate, then puts the branch on its own line. In `leftoff`, the status is in words (`Claude said done · 2 problems open · 23 uncommitted files · stale`), and a long header puts the branch on its own line. |
| 5 | **Tool jargon in words.** "ERROR collecting x" → "pytest can't load x"; "Would reformat" → "needs formatting"; also "module not found", "SyntaxError" and "address in use". Plain-English errors stay as they are ("SMTP connection refused"). The raw line is in `--details` under "Error output:". |
| 6 | **Concrete next steps.** The next step covers the top three problems, then names the command to run again: "Fix the test-loading error in tests/test_semantic_kernel.py, format the 6 files, then run `make run-ci` again". A named test script names its suite (`pnpm test:real` → "the real tests"). In `leftoff`, a next step too long for one line keeps its first action. |
| 7 | **`--details` is the full view.** Every line wraps and nothing is cut; a `command` in backticks isn't split unless it is longer than a line. Each problem has "Already tried:" or "Nothing tried yet.", and attempts name the file's path ("editing src/dynavec/exceptions.py"). The brief's next step and claim lines wrap too. |

## 2. Tests

**RED first** for each rule. Corrections and exceptions:
- **The "connection refused" translation was my mistake.** It turned "SMTP connection refused" into "the connection was refused", which loses information. I removed it and changed the rule to tool jargon only.
- **`otherGroups` bug.** It compared group objects from two separate grouping calls, so the claimed problem was listed twice. Found by the large-brief golden.
- **The wrap test** first passed by accident; I tightened it to a width where the old space-only wrap breaks inside the command.
- **Expectations changed on purpose:** the Rahul next step (now `Fix "SMTP connection refused", then run … again`), the goldens (`large-brief.txt`, `loose-ends.txt`), and the loose-ends and loops headers.
- **Large-brief cap raised to 15 lines:** 3 commit lines plus a wrapped next step.

**Mutation pass.** 9 mutations: chain checks, `ci` targets, the test group, the package merge, the three-action next step, wrapping, the loose-ends count, the header rule, and "Nothing tried yet.". All 9 were caught.

**Results**
- `npm run check`: 1060 passed, 1 skipped.
- `npm run test:e2e`: 20 passed.
- **Timing test:** `brief --auto`'s "after a brief is shown" test failed once under full-suite load (414 ms, budget 300 ms). It passed 3 of 3 runs alone and in every full run after.

## 5. Your real output

```
$ leftoff
Loose ends across 3 projects

Orbit10 · last worked 9d ago · Codex said done · 11 problems open · 23 uncommitted files · stale
  on branch main
  You were working on Orbit10 (an original, Apache-2.0 local workspace for humans and coding…
  Next: Make the real tests pass.
dynavec · last worked 11d ago · Codex said done · 2 problems open
  on branch fix/issue-15-s3vectors-error-mapping
  You were fixing s3vectors error mapping (issue 15).
  Next: Fix the test-loading error in tests/test_semantic_kernel.py.
hackerrank-orchestrate-october26 · last worked 6d ago · Claude said done · 2 uncommitted files · stale
  on branch main
  You were working on: Add playbook.
  Next: Commit the 2 files Claude said were committed.

$ cd ~/dynavec && leftoff resume
dynavec · last worked 11d ago · about 15 min · branch fix/issue-15-s3vectors-error-mapping
  You were fixing s3vectors error mapping (issue 15).
  Codex said it was done, but the project checks still fail: pytest can't load
    tests/test_semantic_kernel.py.
  Next: Fix the test-loading error in tests/test_semantic_kernel.py, format the 6 files, then run
    `make run-ci` again.

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
    • Claude's last update: Your usage limit was reached, so I've paused the build.
    • Nothing failing, all changes committed
  Next: Start the next task (everything from the last session is committed).

$ cd ~/leftoff && leftoff resume
leftoff · last worked just now · about 3 hours over 3 days · branch main
  You were working on brief: one count, words for errors, concrete next steps.
  What got done
    • 12 commits, the newest:
        one count, words for errors, concrete next steps
        group problems, list only real attempts, keep quotes whole
        readable details and dogfood fixes
    • Most changes in tests, docs and src/render (81 files)
  Where it stopped
    • Claude's last update: All 9 caught.
    • Nothing failing, all changes committed
  Next: Start the next task (everything from the last session is committed).

$ cd ~/dynavec && leftoff resume --details
dynavec · last worked 11d ago · about 15 min · branch fix/issue-15-s3vectors-error-mapping
  You were fixing s3vectors error mapping (issue 15).
  Codex said it was done. 2 things are still not right:

  1. The project checks fail: pytest can't load tests/test_semantic_kernel.py
     Error output: ERROR collecting tests/test_semantic_kernel.py
     Command: make run-ci
     Nothing tried yet.

  2. 6 files need formatting
     Error output: unformatted: File would be reformatted
     Commands: uv run --no-sync ruff format --check src/dynavec/exceptions.py
       src/dynavec/__init__.py src/dynavec/stores/s3vectors.py src/dynavec/stores/async_s3vectors.py
       src/dynavec/stores/_s3vectors_errors.py tests/test_s3vectors_errors.py; uv run --no-sync ruff
       format --check src/dynavec/exceptions.py src/dynavec/__init__.py
       src/dynavec/stores/s3vectors.py src/dynavec/stores/async_s3vectors.py
     Files: src/dynavec/__init__.py, src/dynavec/exceptions.py,
       src/dynavec/stores/_s3vectors_errors.py, src/dynavec/stores/async_s3vectors.py,
       src/dynavec/stores/s3vectors.py, tests/test_s3vectors_errors.py
     Already tried: running the async_s3vectors, list_vectors and other tests, editing
       src/dynavec/exceptions.py, adding src/dynavec/stores/_s3vectors_errors.py, editing
       src/dynavec/stores/s3vectors.py, editing src/dynavec/stores/async_s3vectors.py

  What changed: 6 files, most in src/dynavec and tests
  Next: Fix the test-loading error in tests/test_semantic_kernel.py, format the 6 files, then run
    `make run-ci` again.
```

## 9. Things to know

1. **A check in the middle of a `;` chain gets credit** whenever the chain succeeds, because only the last step's exit code is known (`cargo test; echo done`). Masked failures are still caught when output is piped into a filter. Should I also record a successful `;` chain whose output shows failing tests as a test failure? That would close the gap.
2. **The "You were" line is still cut** in `leftoff` and the brief (Orbit10's README line), and so is the folders line ("…and… (72 files)"). Only headers, next steps, claims and `--details` never cut.
3. **Commands listed twice.** In dynavec's `--details`, the two ruff commands are both listed in full under "Commands:", although they mostly overlap.
