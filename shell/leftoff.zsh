# leftoff shell hook for zsh. `leftoff setup` copies this file to
# ${LEFTOFF_HOME:-~/.leftoff}/shell/ and sources it from ~/.zshrc.
#
# After each command it appends one tab-separated line to shell/shell.log:
#   ts_epoch_ms  exit_code  duration_ms  pid  cwd  command
# Commands typed with a leading space are never recorded. It never prints.

[[ -o interactive ]] || return 0
zmodload zsh/datetime 2>/dev/null || return 0
autoload -Uz add-zsh-hook

typeset -g __leftoff_cmd= __leftoff_start= __leftoff_cwd=

__leftoff_preexec() {
  __leftoff_cmd=$1 # the line as typed, including a leading space
  __leftoff_start=$EPOCHREALTIME
  __leftoff_cwd=$PWD
}

__leftoff_precmd() {
  local exit_code=$? cmd=$__leftoff_cmd
  __leftoff_cmd=
  [[ -n $cmd && $cmd != ' '* && $LEFTOFF_INTERNAL != 1 ]] || return 0
  local log=${LEFTOFF_HOME:-$HOME/.leftoff}/shell/shell.log
  [[ -d ${log:h} ]] || return 0
  local now=$EPOCHREALTIME
  local -i ts=$(( now * 1000 )) duration=$(( (now - __leftoff_start) * 1000 ))
  local cwd=${__leftoff_cwd//[$'\t\r\n']/ }
  cmd=${cmd//$'\\\n'/ } # line continuations, joined as the shell joins them
  cmd=${cmd//[$'\t\r\n']/ }
  [[ -e $log ]] || (umask 077 && : >>$log) 2>/dev/null
  print -rn -- "$ts"$'\t'"$exit_code"$'\t'"$duration"$'\t'"$$"$'\t'"$cwd"$'\t'"$cmd"$'\n' >>$log 2>/dev/null
  return 0
}

# Automatic brief on terminal open; wired up in Task 14.
__leftoff_auto() { :; }

add-zsh-hook preexec __leftoff_preexec
add-zsh-hook precmd __leftoff_precmd
