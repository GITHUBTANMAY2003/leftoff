# Task 15c: Briefs sized by the work

You asked for the brief to grow with the amount of work: 2–3 lines after small work, about 6 after medium, and 8–12 in sections after large work. The auto brief and `leftoff` (all projects) stay compact, and standup uses the same "what got done" data.

Two commits, not pushed:
- `2a4ba11` feat(brief): briefs sized by the work
- `9e92a72` fix(git): read the resumed project first (found during the proof run)

The proof on your real data is in §5, with my verdict per project. Open questions are in §9.

## 1. How the size is computed (deterministic, generic signals only)

**The "where you left off" stretch:** the last work session, plus earlier work sessions while each break is under 48 h, over at most 14 days. Look-around sessions (a terminal opened, `git log`, `leftoff resume`) don't count. The open problems, the claim and the next step still come from the last session (as in 15b). The stretch only decides "what was done".

| Signal | Rule |
|---|---|
| Active time | Summed session lengths (45-min session gap, each session at least 5 min) |
| Days | Work splits into periods at idle breaks of ≥ 8 h (a night's sleep, wherever midnight falls); days = the distinct local dates on which periods start |
| Commits | Your commits in the stretch, subjects without their `type(scope):` prefix |
| Files changed | Agent edits + each commit's file list (new: the git collector stores it), inside the project; hidden folders (`.github`, `.superpowers`, …) left out |
| Top folders | At most 3, by file count; one level deeper inside `src`, `lib`, `crates`, `packages`, `apps`, `services`, `pkg`, `cmd`, `internal`, `modules`, `components`; files at the root read "the top folder" |

**Size:**
- **small:** < 30 min, ≤ 1 commit, and one day.
- **large:** (≥ 2 days or ≥ 4 h) and (≥ 3 commits or ≥ 20 files).
- **medium:** everything else.

**"You were …"** uses the first of these that says something:
1. **A descriptive branch name.** `fix/issue-15-s3vectors-error-mapping` → "fixing s3vectors error mapping (issue 15)"; `feature/forgot-password` → "building forgot password". `main`, `wip` and `feat/m0-m1` say nothing, so the next rule applies.
2. **Commit scopes that recur,** when most commits have a scope ("working on semantic, kb and adapters").
3. **The first commit's subject** ("working on: human-readable briefs").
4. **The first substantive request**, meaning a sentence of at least 4 words that isn't:
   - a tool notice (`<task-notification>`, Codex's `# Files pasted by the user`);
   - an approval or a continuation ("ok continue", "approved");
   - a hedge ("I guess…", "I mean…", "So…");
   - a question.
5. **The top folders** ("working in docs and tests").

Order 2–3 before 4 differs from your order. §9.1 explains why.

## 2. The formats

**Medium** (the §1.1 scenario, golden `tests/render/golden/rahul-brief.txt`):
```
myapp · last worked 14h ago · about 1.5 hours · branch feature/forgot-password
  You were building forgot password.
  Done: 2 commits: Added reset-token migration; Built POST /auth/forgot-password endpoint
  Claude's last update: The SMTP server still refuses the connection on both ports.
  Stopped: `python scripts/send_test_email.py` — SMTP connection refused · 1 uncommitted file
  Next: Get `python scripts/send_test_email.py` working (SMTP connection refused).
```

**Large:** header; `You were …`; `What got done` (`• N commits: up to 4 newest`, `• Most changes in … (N files)`); `Where it stopped` (the claim or the agent's last update, at most 2 other problems grouped by how they read with "(and N more problems)", the uncommitted count); `Next:`. Golden: `tests/render/golden/large-brief.txt`.

**Small:** header, `You were …` (plus the claim, if any), `Next:`.

**Where each form is used:**
- **The agent context:** the sized brief (bullets as `- `), then the open problems with what was already tried, and the uncommitted files.
- **The auto brief:** always compact, even after large work. Header, `You were`, `Stopped` (or the claim and `Also open`), `Next`, then `Run \`leftoff resume\` for the full story`. The polished summary stays at most two sentences.
- **`leftoff` (all projects):** 3 lines per project.
  - The header carries the claim and the flags. The name and branch are shortened only past 32 characters; the flags are cut at the end.
  - The `Next:` line ends with `(also: N more problems, M uncommitted files)`. If it's too long, the next step's trailing bracket (the command or the error) is dropped first.
- **Standup Yesterday:** short commit subjects, at most 4, then "+N more commits", then "Most changes in … (N files)".

## 3. Fixes found on your data during the proof run (each with a failing test first)

| What I saw | Fix |
|---|---|
| dynavec: `make run-ci` — `/Library/Developer/CommandLineTools/usr/bin/make lint` (make echoing a command) | The error shown is the first output line that reads like an error (decoration trimmed, one-word headers skipped) → `ERROR collecting tests/test_semantic_kernel.py` |
| LoopLint: `` `cargo fmt … \| tail -3; cargo test --workspace \| grep …` — failed `` | A `;`/`&&` chain of checks reads as its last check → "the Rust tests are failing" |
| Orbit10: `` `ollama serve` — exit code 137 `` | 137, 139 and 126 are put in words → "was killed (exit code 137, often out of memory)" |
| LoopLint: the adapters failure listed twice; leftoff: "N uncommitted files" twice | A problem (or uncommitted count) the claim already names isn't repeated |
| LoopLint: "Most changes in .superpowers, …" | Hidden folders are tooling, not where the work was |
| leftoff: "You were working on brief and dogfood" (each scope in 1 commit) | Scopes are used only when they recur; else the first subject |
| Orbit10: "You were working on: I guess we haven't done much…" / "Our implementation stopped." | Hedges are not requests, and the request fallback uses the same filter |
| dynavec: "over 2 days" for a 15-minute session at midnight | Days come from 8 h idle breaks, not calendar midnight |
| Claim lines losing their "but …" part | No room for the quote → `Codex said done, but …` |
| loose ends: `leftoff…` (name cut for the flags) | The name stays; the flags are cut |
| **`leftoff resume` didn't show the commit made minutes before** | **Git read the least recently checked repos first and stopped at the deadline (about 0.4 s per repo here). The project being resumed is now read first (`9e92a72`).** |

## 4. Tests

**New tests**
- `tests/brief/work.test.ts`: 28 cases.
  - Rust large: 2 days, 4 commits, crates folders, recurring scope.
  - Python medium: one afternoon, descriptive `fix/issue-42-…` branch, `src/svc` + `tests`.
  - JS small: 15 minutes, `src/components`, tool notices and "ok continue" skipped.
  - The branch-to-words table (13 names), days across midnight and across a night, hidden folders, the folder fallback, and size edge cases.
- `tests/render/narrative.test.ts`: small/medium/large goldens, plus each line rule.
- Further cases in `tests/render/loose-ends.test.ts`, `tests/render/standup.test.ts`, `tests/brief/facts.test.ts` (the stretch, the error line), `tests/brief/failure-words.test.ts` (chains, exit codes) and `tests/collectors/git.test.ts` (commit files, resumed project first).

**Changed on purpose.** These goldens and expectations follow the new format: `rahul-brief.txt`, `rahul-auto.txt`, `loose-ends.txt`, the e2e scenario (resume still equals the golden byte for byte), and the resume, brief-auto, loops and agent-context tests.

**Test runs use `TZ=UTC`** (vitest `env`), so day counts don't depend on where the tests run.

**A test-environment fix.** Since `npm link`, your PATH has a real `leftoff`. The shell tests' fallback (`command leftoff`) found it and broke 3 tests. The tests now run with a PATH where any folder holding `leftoff` is replaced by a stand-in folder with links to everything else in it (fish, git, …).

**RED first** for every rule above. Exceptions:
- the "trailing bracket" loose-ends test was written after its code;
- the "resumed project first" test first passed by accident (equal check times), so I rewrote it to reproduce the bug, and it then failed before the fix.

**Mutation pass.** I ran 11 mutations: the stretch gap, the error line, recurring scopes, hidden folders, the day breaks, the small-size conditions, chains, claim dedupe, large sections, the bracket drop, and the standup cap.
- 10 were caught.
- The small-size conditions mutant survived. I added a test ("short but with several commits, or over two days, is not small"), and it is now caught.

**Results**
- `npm run check`: tsc, eslint and prettier clean; 999 passed, 1 skipped.
- `npm run test:e2e`: 18 passed.

## 5. Proof: your real data (`leftoff resume`, then `leftoff`), with my verdict

Your criterion: *after a week away, do I understand what I did, where it stopped and what to do next, without decoding anything?*

**LoopLint** (large) — **yes for "where it stopped" and "next"; partly for "what I did":**
```
LoopLint · last worked 7d ago · about 4.5 hours · branch feat/m0-m1
  You were working on semantic, kb and adapters.
  What got done
    • 28 commits: unique keys, project-owned names, plain-function tools; subscripted callees…
    • Most changes in crates/looplint_adapters, crates/looplint_workspace and… (22 files)
  Where it stopped
    • Claude said "Tasks 0–10 are complete…", but the looplint_adapters tests are still failing.
    • the Rust tests are failing
    • the looplint_semantic tests are failing (and 2 more problems)
  Next: Make the looplint_adapters tests pass (`cargo test -p looplint_adapters`).
```
- The commit subjects are cut at 100 columns, so only about 1.5 of the 4 newest show.
- "semantic, kb and adapters" are your scope names: clear to you, terse to others.

**dynavec** (medium) — **yes:**
```
dynavec · last worked 11d ago · about 15 min · branch fix/issue-15-s3vectors-error-mapping
  You were fixing s3vectors error mapping (issue 15).
  Codex said "The 51 existing relevant tests have also finished…", but `make run-ci` still fails.
  Next: Get `make run-ci` working (ERROR collecting tests/test_semantic_kernel.py).
```

**Orbit10** (medium) — **"where it stopped" and "next" yes; "what I did" no:**
```
Orbit10 · last worked 8d ago · about 1 hour · branch main
  You were working in docs and tests.
  Done: changed 50 files, most in the top folder, docs and tests
  Codex said done, but `ollama serve` still gets killed (exit code 137, often out of memory).
  Also open: 13 more problems · 23 uncommitted files
  Next: Find out why `ollama serve` was killed.
```
- No commits, branch `main`, and every request in the stretch is a pasted file, a hedge or a question, so only folders are left.
- The `ollama serve` "failure" is probably a server Codex started and then stopped (§9.3).

**leftoff** (large; your current session, after the commits):
```
leftoff · last worked just now · about 2 hours over 2 days · branch main
  You were working on brief.
  What got done
    • 6 commits: read the resumed project first; briefs sized by the work; npm link done, first…
    • Most changes in tests, docs and src/brief (37 files)
  Where it stopped
    • Claude's last update: Now 5 commits and 37 changed files; the "2 files uncommitted" is this…
    • Nothing failing, all changes committed
  Next: Start the next task (everything from the last session is committed).
```
- "Where it stopped" and "next" are right.
- "You were working on brief" is thin (§9.2).

**`leftoff` (all projects):**
```
Loose ends across 5 projects

Orbit10 (main) · last worked 8d ago · Codex said done, 10 problems still failing · stale
  You were working in docs and tests.
  Next: Find out why `ollama serve` was killed (also: 4 more problems, 23 uncommitted files)
LoopLint (feat/m0-m1) · last worked 7d ago · Claude said done, 5 tests still failing
  You were working on semantic, kb and adapters.
  Next: Make the looplint_adapters tests pass (`cargo test -p looplint_adapters`).
dynavec (fix/issue-15-s3vectors… · last worked 11d ago · Codex said done, 3 problems still failing
  You were fixing s3vectors error mapping (issue 15).
  Next: Get `make run-ci` working (ERROR collecting tests/test_semantic_kernel.py).
hackerrank-orchestrate-october2… · last worked 6d ago · Claude said done, 2 uncommitted files ·…
  You were working on: Add playbook.
  Next: Commit the 2 files Claude said were committed.
apple · last worked 31m ago
  Next: Get `cd~/leftoff` working (exit code 127).
```
The `apple` entry is still waiting on your answer from the Task 17 report §9.2 (home folder, typo).

**Auto brief** (LoopLint, on a copy of your DB with the gap set to 0, so your real "shown" marker is untouched):
```
LoopLint · last worked 7d ago · about 4.5 hours · branch feat/m0-m1
  You were working on semantic, kb and adapters.
  Claude said "Tasks 0–10 are complete, with…", but the looplint_adapters tests are still failing.
  Also open: 4 more problems
  Next: Make the looplint_adapters tests pass (`cargo test -p looplint_adapters`).
Run `leftoff resume` for the full story
```

## 8. Limits

- **Commits made before today have no stored file list.** Their files count only through agent edit events. A re-read could fill them in (§9.4).
- **Each git check took about 0.4 s per repo** on your machine during the proof. Many tracked folders no longer exist (temp fixtures), and each still costs a few git calls. Not investigated yet; it is now harmless for `resume` (resumed project first).
- **Polish** is unchanged: cached summaries are shown first.

## 9. Questions for you

1. **"You were" order.** You wrote: branch → first substantive request → commit subjects. On your data, the requests are conversational, dictated or pasted. LoopLint's first request was "Kill the work, because I actually forgot to put Opus 5.5 off…", and Orbit10's are all hedges and questions. Your commits are precise. So I put commits before requests. Keep it, or switch back to your order?
2. **A single recurring scope is thin** ("You were working on brief"). Add the newest subject in that case, e.g. "working on brief: briefs sized by the work"?
3. **An agent's server killed by the agent** (`ollama serve`, exit 137 after Codex stopped it): keep counting it as a problem, or ignore 137/143 for long-running server commands (`serve`, `dev`, `start`, `watch`)?
4. **Fill in file lists for older commits** with a one-time git re-read? Like the Claude re-read, it would update rows already stored, after a backup.
5. Still open from Task 17 §9: the home folder as a project, and typos like `cd~/leftoff` (exit 127).
