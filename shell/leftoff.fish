# leftoff shell hook for fish. `leftoff setup` copies this file to
# $LEFTOFF_HOME/shell/ (default ~/.leftoff/shell/) and sources it from
# ~/.config/fish/config.fish.
#
# After each command it appends one tab-separated line to shell/shell.log:
#   ts_epoch_ms  exit_code  duration_ms  pid  cwd  command
# Timestamps have second resolution (fish has no millisecond clock). Commands
# typed with a leading space are never recorded. It prints nothing but the
# automatic brief (below).

if status is-interactive
    function __leftoff_preexec --on-event fish_preexec
        set -g __leftoff_cwd $PWD
    end

    function __leftoff_postexec --on-event fish_postexec
        set -l exit_code $status
        set -l cmd $argv[1]
        test -n "$cmd"; or return 0
        string match -q -- ' *' "$cmd"; and return 0
        test "$LEFTOFF_INTERNAL" = 1; and return 0
        set -l home $HOME/.leftoff
        test -n "$LEFTOFF_HOME"; and set home $LEFTOFF_HOME
        test -d $home/shell; or return 0
        set -l log $home/shell/shell.log
        set -l duration -1
        string match -qr '^[0-9]+$' -- "$CMD_DURATION"; and set duration $CMD_DURATION
        set -l cwd $__leftoff_cwd
        test -n "$cwd"; or set cwd $PWD
        set cmd (string replace -ra '[\t\r\n]' ' ' -- "$cmd")
        set cwd (string replace -ra '[\t\r\n]' ' ' -- "$cwd")
        if not test -e $log
            touch $log 2>/dev/null; and chmod 600 $log 2>/dev/null
        end
        printf '%s\t%s\t%s\t%s\t%s\t%s\n' (date +%s)000 $exit_code $duration $fish_pid "$cwd" "$cmd" >>$log 2>/dev/null
    end

    # Automatic brief (Task 14): on the first prompt, and on a prompt in
    # another project (its git top level, else the folder), run
    # `leftoff brief --auto`. It prints only when a brief is due.
    set -q __leftoff_auto_pwd; or set -g __leftoff_auto_pwd
    set -q __leftoff_auto_project; or set -g __leftoff_auto_project

    function __leftoff_auto --on-event fish_prompt
        test "$PWD" = "$__leftoff_auto_pwd"; and return 0
        set -g __leftoff_auto_pwd $PWD
        test "$LEFTOFF_INTERNAL" = 1; and return 0
        set -l project (command git rev-parse --show-toplevel 2>/dev/null)
        test -n "$project"; or set project $PWD
        test "$project" = "$__leftoff_auto_project"; and return 0
        set -g __leftoff_auto_project $project
        set -l home $HOME/.leftoff
        test -n "$LEFTOFF_HOME"; and set home $LEFTOFF_HOME
        if test -x $home/bin/leftoff
            $home/bin/leftoff brief --auto 2>/dev/null
        else if command -sq leftoff
            command leftoff brief --auto 2>/dev/null
        end
    end
end
