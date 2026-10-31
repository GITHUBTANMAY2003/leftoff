# leftoff — dogfood log (Task 17)

One entry per brief you look at after time away: the auto brief when you open a
terminal, or `leftoff resume`. Paste what it said when something was wrong.
Claude turns each "no" into a failing test, a fix and a line under **Fixed**.

The release gate (Task 17 exit criteria): briefs judged correct on at least
90% of logged days, and at least 4 of 5 beta testers' briefs rated "yes".

## Template

```
### YYYY-MM-DD — <project>
- Time away: <e.g. 14 h, 2 days>
- Where: auto brief / `leftoff resume` / `leftoff` (loose ends) / Claude Code context
- Did the brief correctly tell me where I left off and what to do next? yes / no
- What was wrong or missing: <wrong line, missing fact, false "Agent said done", slow, error output>
- Brief as shown (only when wrong):
- Fixed: <commit, filled in by Claude>
```

## Entries

<!-- newest first -->

### 2026-11-01 — home folder (found by Claude while checking the Task 17 setup)

- Time away: under 1 h
- Where: `leftoff` (loose ends)
- Did the brief correctly tell me where I left off and what to do next? no
- What was wrong or missing: your home folder showed up as a project, `apple · 4m ago`, with a mistyped command as its open problem. Waiting for your decision (Task 17 report §9).
- Brief as shown:
  ```
  apple · 4m ago
    ✗ `cd~/leftoff` — exit code 127 (3 attempts)
  ```
- Fixed:

## Beta tester ratings

| Tester | Date | Time away | Correct where you left off and what to do next? (yes/no) | Note |
|---|---|---|---|---|
