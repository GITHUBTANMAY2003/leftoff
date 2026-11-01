# Task 15f: Three sections, no LLM

This is your decision after 15e: no LLM in the main experience. `leftoff resume` and `--details` now have exactly three sections, built from your own words: the branch, the commits, the names in the diff, and the failures. Polish stays optional and off by default; nothing new is built on it. Commits `abf2696` (plus this report), not pushed.

## 1. What changed

**`leftoff resume`.** Under the header there are three sections.

- **What you did:** two to four sentences.
  - The goal, from a descriptive branch name, the commits or the first substantive request. An issue goes first: "fixing issue #15: s3vectors error mapping".
  - What was built, from the work window's diff: new modules (described by their own docstring), new exception types and classes, and tests added. When nothing new can be named: "You changed N files, mostly in a, b and c (+N more folders)".
  - The agent's claim, if there is one.
  - No file paths.
- **Files you changed:** one line per file, most important first. Up to 4, 6 or 8 by work size (8 in `--details`), then "+N more files".
  - The order: new code, files with new definitions, files that use something new, new tests, other edits, then new documents.
  - The wording: `new: <its own docstring>`, "added 2 new exceptions (access denied, validation)", "added f, g", "removed f", "now uses the new translate_client_errors", "21 tests for s3vectors errors".
  - Files with the same change share a line. Names are short unless two files share a name; then they get as much of the path as tells them apart. Lockfiles are left out.
- **What's left:**
  - the merged problems, counted as in every view;
  - uncommitted files;
  - the agent's unanswered question ("Claude asked: …");
  - your notes;
  - then exactly one "Start here: …" line.

**`leftoff resume --details`.** The same three sections. Under each problem it adds the error line, each distinct command once (shortened like `ruff format --check (6 files)`), and "Already tried: …" or "Nothing tried yet.". Raw data is in `--json` only.

**`leftoff` (all projects).** Per project: the header, the goal line, and "Start here:".

**How it is built.**
- `src/brief/changes.ts`:
  - **The diff:** the window's diff runs from just before its first commit to the working tree, so it covers committed and uncommitted work, plus untracked files. It is limited to the window's commits' files and the uncommitted ones, so a teammate's commit pulled in between doesn't count.
  - **Definitions and tests:** one pattern table per language finds definitions and tests (Python, JS/TS, Go, Rust, Java/Kotlin/C#, C/C++, shell).
  - **Descriptions:** a new file's description is its module docstring or header comment, read to the end of its first sentence (across lines), or a Markdown file's first heading.
- `src/brief/story.ts` turns the changes into the file lines and the "what was built" sentence.
- `src/render/story.ts` renders the three sections.

## 2. Correctness fixes

- **A real bug found on your data.** The git collector's one-time re-read in 15b looked back only 7 days, so your dynavec commit `16b56ed` (10 days old at the time) was never recorded, and neither were its files. The re-read now covers the retention window (30 days). The cursor format is now 3, so every repo was re-read once; dynavec's commit is in.
- **Failed tests anywhere in a chain:** a run whose output shows failed tests counts as failed, however the chain ends (`cargo test; echo done`).
- **README sentences** are kept whole, cut only at a sentence boundary, never mid-word.
- **Folder lists** show at most 3, then "(+N more folders)".

## 3. Tests

**RED first** for each rule. New test files:
- `tests/brief/changes.test.ts`: the diff parser, definitions for 9 languages, tests per language, descriptions;
- `tests/brief/story.test.ts`;
- `tests/render/story.test.ts`, with the golden `story-brief.txt`.

Updated on purpose: the resume tests (three sections, a real git repo case), loose ends and loops ("Start here:"), and the e2e golden `rahul-resume.txt`. The old details renderer and its tests are removed.

**Problems the tests and your real data found along the way:**
- a one-file command was shortened to "python (1 file)";
- an untracked folder (`tests/`) hid its new files;
- a commit hash unknown to the repo made the diff start from nothing;
- Markdown plans and `Cargo.lock` ranked first in LoopLint;
- Rust's multi-line `//!` doc comments were cut after their first line;
- two `resolve.rs` files read as "src/resolve.rs".

All are fixed with tests.

**Mutation pass.** 7 mutations applied, all caught. An eighth didn't match the formatted text; the diff parser's test checks that case.

**Results**
- `npm run check`: 1094 passed, 1 skipped.
- `npm run test:e2e`: 20 passed.

## 5. Your real output

```
$ cd ~/dynavec && leftoff resume
dynavec · last worked 11d ago · about 25 min · branch fix/issue-15-s3vectors-error-mapping
  What you did
    You were fixing issue #15: s3vectors error mapping. You added a new module (shared error
    translation for S3 Vectors AWS calls), 2 new exception types and 21 tests. Codex said the work
    was done.
  Files you changed
    • _s3vectors_errors.py — new: shared error translation for S3 Vectors AWS calls
    • exceptions.py — added 2 new exceptions (access denied, validation)
    • s3vectors.py, async_s3vectors.py — now use the new translate_client_errors
    • __init__.py — now uses the new AccessDeniedError
    • +1 more file
  What's left
    • CI fails: pytest can't load test_semantic_kernel.py
    • 6 files need formatting
    Start here: fix the test-loading error in test_semantic_kernel.py, format the 6 files, then run
    `make run-ci` again.

$ cd ~/dynavec && leftoff resume --details
  (the same, all 6 files listed, and under each problem:)
    • CI fails: pytest can't load test_semantic_kernel.py
      Error: ERROR collecting tests/test_semantic_kernel.py
      Command: make run-ci
      Nothing tried yet.
    • 6 files need formatting
      Error: unformatted: File would be reformatted
      Command: ruff format --check (6 files)
      Already tried: running the async_s3vectors, list_vectors and other tests

$ cd ~/LoopLint && leftoff resume
LoopLint · last worked 8d ago · about 4.5 hours · branch feat/m0-m1
  What you did
    You were working on semantic, kb and adapters. You added 32 new modules, 2 new exception types
    and 374 tests.
  Files you changed
    • src/resolve.rs — new: name resolution across files, and the values that names and expressions
      stand for
    • mod.rs — new: lowering of a tree-sitter Python tree to FileSemantics
    • declarative.rs — new: the declarative adapter: turns a framework's [agent], [run],
      [tool_decorator], [tool_factory] and [handoff_wrapper] mappings from the knowledge base into
      drafts
    • load.rs — new: loading and validating the knowledge base from TOML
    • index.rs — new: the project index: which file is which Python module, and lazy, memoized,
      thread-safe parsing and lowering of those files
    • expr.rs — new: expression lowering: literals, containers, operators, comprehensions and calls
    • manifests.rs — new: framework versions read from Python manifests and lockfiles
    • src/dataflow.rs — new: taint flow from a tool function's parameters to shell and
      code-execution sinks (subprocess.run(cmd, shell=True), os.system(...), eval(...))
    • +66 more files
  What's left
    • Nothing failing, all changes committed
    Start here: start the next task (everything from the last session is committed).

$ leftoff
Loose ends across 3 projects

Orbit10 · last worked 9d ago · Codex said done · 11 problems open · 23 uncommitted files · stale
  on branch main
  You were working on Orbit10 (an original, Apache-2.0 local workspace for humans and coding
    agents): mostly docs and tests.
  Start here: make the real tests pass.
dynavec · last worked 11d ago · Codex said done · 2 problems open
  on branch fix/issue-15-s3vectors-error-mapping
  You were fixing issue #15: s3vectors error mapping.
  Start here: fix the test-loading error in test_semantic_kernel.py.
hackerrank-orchestrate-october26 · last worked 7d ago · Claude said done · 2 uncommitted files · stale
  on branch main
  You were working on: Add playbook.
  Start here: commit the 2 files Claude said were committed.
```

## 9. Things to know

1. **dynavec, compared with your example.** Your example said "two new exception types (not found, throttled)" and "9 tests". The real diff adds `AccessDeniedError` and `ValidationError`, and 21 tests, so that's what it says.
2. **LoopLint's file lines are long.** Its doc comments are full sentences, so a line can wrap two or three times. A cap per description would cut sentences, which you ruled out.
3. **Only `resume`, `--details` and `leftoff` changed.** The agent context (Claude Code's session start) and the auto brief still use the earlier sized/compact brief.
