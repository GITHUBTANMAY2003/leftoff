# leftoff — dogfood checklist (Task 17)

Commands assume `leftoff` is on your PATH (after `npm link`, Task 17 Step 1).
Anything unexpected goes into `docs/dogfood-log.md`.

## Daily (about 2 minutes)

1. **Doctor exits 0**
   ```bash
   leftoff doctor; echo "exit $?"
   ```
2. **No new errors in the log** (look at the dates)
   ```bash
   tail -20 ~/.leftoff/logs/leftoff.log
   ```
3. **Timings within budget** (§1.12): `resume` under 300 ms with nothing new, `leftoff` under 1.5 s
   ```bash
   cd ~/leftoff && time leftoff resume >/dev/null
   ```
   ```bash
   time leftoff >/dev/null
   ```
4. **Secret scan finds nothing** (no output is the pass)
   ```bash
   sqlite3 ~/.leftoff/leftoff.db .dump | grep -E "ghp_|sk-|AKIA|BEGIN .*PRIVATE KEY|password=|hunter2"
   ```
5. **Rate one brief** in `docs/dogfood-log.md`: did it tell you where you left off and what to do next?

## Weekly

0. **Performance budgets, strict** (CI only checks 3× the budgets; run with nothing else busy):
   ```bash
   PERF_STRICT=1 npm run test:e2e
   ```


6. **Probe failures hide nothing real** (look-around commands that "failed")
   ```bash
   sqlite3 ~/.leftoff/leftoff.db "select ts, summary from events where json_extract(data,'$.probe') = 1 order by ts desc limit 50"
   ```
7. **Scratch failures hide nothing real** (heredocs, inline code, temp folders)
   ```bash
   sqlite3 ~/.leftoff/leftoff.db "select ts, summary from events where json_extract(data,'$.scratch') = 1 order by ts desc limit 50"
   ```
   Scratch and agent-tool errors are also decided when reading, so these lists are a sample. If a real problem looks hidden, log it with the command and project.

## Once during dogfooding

8. **Warm Ollama polish on the 8 GB MacBook Air** (the cold call timed out at 60 s in Task 12). Load the model, then time a polish:
   ```bash
   ollama run "$(leftoff config get polish.ollamaModel)" "hi" >/dev/null
   ```
   ```bash
   cd ~/leftoff && time leftoff resume --polish >/dev/null
   ```
   Record the time and the model in the log. This needs `polish.provider` set to `ollama` for the run (`leftoff config set polish.provider ollama`; set it back afterwards).
9. **Uninstall and reinstall once** (exit criterion): `leftoff uninstall`, then `leftoff setup`.

## At the end of Task 17

10. **Delete the two backups** (kept until now, mode 600):
    ```bash
    rm ~/.leftoff/leftoff-before-claude-reread.db ~/.leftoff/leftoff-before-files-backfill.db
    ```
