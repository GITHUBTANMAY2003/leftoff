# leftoff shell hook for zsh. `leftoff setup` copies this file to
# ${LEFTOFF_HOME:-~/.leftoff}/shell/ and sources it from ~/.zshrc.
#
# After each command it appends one tab-separated line to shell/shell.log:
#   ts_epoch_ms  exit_code  duration_ms  pid  cwd  command
# Commands typed with a leading space are never recorded. It prints nothing
# but the automatic brief (below).

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

# Automatic brief (Task 14): on the first prompt, and on a prompt in another
# project (its git top level, else the folder), run `leftoff brief --auto`. It
# prints only when a brief is due. Kept across re-sourcing, so no repeat.
typeset -g __leftoff_auto_pwd=$__leftoff_auto_pwd __leftoff_auto_project=$__leftoff_auto_project

__leftoff_auto() {
  local exit_code=$?
  [[ $PWD != "$__leftoff_auto_pwd" ]] || return $exit_code
  __leftoff_auto_pwd=$PWD
  [[ $LEFTOFF_INTERNAL != 1 ]] || return $exit_code
  local project
  project=$(command git rev-parse --show-toplevel 2>/dev/null)
  [[ -n $project ]] || project=$PWD
  [[ $project != "$__leftoff_auto_project" ]] || return $exit_code
  __leftoff_auto_project=$project
  local shim=${LEFTOFF_HOME:-$HOME/.leftoff}/bin/leftoff
  if [[ -x $shim ]]; then
    "$shim" brief --auto 2>/dev/null
  elif (( $+commands[leftoff] )); then
    command leftoff brief --auto 2>/dev/null
  fi
  return $exit_code
}

add-zsh-hook preexec __leftoff_preexec
add-zsh-hook precmd __leftoff_precmd
add-zsh-hook precmd __leftoff_auto
