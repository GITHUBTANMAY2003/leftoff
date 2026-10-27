# leftoff shell hook for bash (works on bash 3.2, the macOS /bin/bash).
# `leftoff setup` copies this file to ${LEFTOFF_HOME:-~/.leftoff}/shell/ and
# sources it from ~/.bashrc.
#
# After each command it appends one tab-separated line to shell/shell.log:
#   ts_epoch_ms  exit_code  duration_ms  pid  cwd  command
# bash has no hook before a command runs, so duration_ms is always -1 and cwd
# is the directory at the next prompt. Commands typed with a leading space are
# never recorded. It prints nothing but the automatic brief (below).

case $- in *i*) ;; *) return 0 ;; esac

__leftoff_hist=
__leftoff_ready=

__leftoff_prompt() {
  local exit_code=$? line num cmd log ts cwd
  line=$(HISTTIMEFORMAT= builtin history 1 2>/dev/null)
  line=${line#"${line%%[![:space:]]*}"} # "  42  make" -> "42  make"
  num=${line%%[[:space:]]*}
  if [ -z "$__leftoff_ready" ]; then
    # First prompt: the newest history entry is from before this hook loaded.
    __leftoff_ready=1
    __leftoff_hist=$num
    return $exit_code
  fi
  # Same history number: empty line, or nothing was added to history.
  if [ -z "$num" ] || [ "$num" = "$__leftoff_hist" ]; then return $exit_code; fi
  __leftoff_hist=$num
  cmd=${line#"$num"}
  cmd=${cmd#  } # history prints two spaces after the number
  case $cmd in '' | ' '*) return $exit_code ;; esac
  [ "${LEFTOFF_INTERNAL:-}" = 1 ] && return $exit_code
  log=${LEFTOFF_HOME:-$HOME/.leftoff}/shell/shell.log
  [ -d "${log%/*}" ] || return $exit_code
  if [ -n "${EPOCHREALTIME:-}" ]; then # bash >= 5: microseconds -> milliseconds
    ts=${EPOCHREALTIME/[.,]/}
    ts=${ts%???}
  else
    ts=$(date +%s)000
  fi
  cmd=${cmd//$'\t'/ }
  cmd=${cmd//$'\r'/ }
  cmd=${cmd//$'\n'/ }
  cwd=${PWD//$'\t'/ }
  [ -e "$log" ] || (umask 077 && : >>"$log") 2>/dev/null
  printf '%s\t%s\t%s\t%s\t%s\t%s\n' "$ts" "$exit_code" -1 "$$" "$cwd" "$cmd" >>"$log" 2>/dev/null
  return $exit_code
}

# Automatic brief (Task 14): on the first prompt, and on a prompt in another
# project (its git top level, else the folder), run `leftoff brief --auto`. It
# prints only when a brief is due. Keeps $? for the rest of PROMPT_COMMAND.
__leftoff_auto() {
  local exit_code=$? project shim
  [ "$PWD" != "${__leftoff_auto_pwd:-}" ] || return $exit_code
  __leftoff_auto_pwd=$PWD
  [ "${LEFTOFF_INTERNAL:-}" != 1 ] || return $exit_code
  project=$(command git rev-parse --show-toplevel 2>/dev/null)
  [ -n "$project" ] || project=$PWD
  [ "$project" != "${__leftoff_auto_project:-}" ] || return $exit_code
  __leftoff_auto_project=$project
  shim=${LEFTOFF_HOME:-$HOME/.leftoff}/bin/leftoff
  if [ -x "$shim" ]; then
    "$shim" brief --auto 2>/dev/null
  elif command -v leftoff >/dev/null 2>&1; then
    command leftoff brief --auto 2>/dev/null
  fi
  return $exit_code
}

case ";${PROMPT_COMMAND:-};" in
  *";__leftoff_prompt;"*) ;;
  *) PROMPT_COMMAND="__leftoff_prompt;__leftoff_auto${PROMPT_COMMAND:+;$PROMPT_COMMAND}" ;;
esac
