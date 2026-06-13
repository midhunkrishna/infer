/**
 * Emits shell-integration scripts for `infer init <shell>`.
 *
 * The integration's jobs:
 *  - record the last command line, its exit code, and cwd into a per-shell dir
 *  - tee command output into a bounded ring buffer (segmented per command)
 *  - never let `infer` itself overwrite the recorded command
 *  - restore the real TTY for interactive programs (pagers, editors) so they
 *    aren't degraded by the capture pipe
 *  - define an `infer` wrapper so a chosen fix runs in the CURRENT shell
 *    (so `cd`/`export` fixes persist)
 */

export type SupportedShell = "zsh" | "bash" | "fish";

/** Programs whose output we must NOT route through the capture pipe. */
const INTERACTIVE_DENYLIST = [
  "vim",
  "nvim",
  "vi",
  "nano",
  "emacs",
  "less",
  "more",
  "man",
  "top",
  "htop",
  "btop",
  "fzf",
  "ssh",
  "tmux",
  "screen",
  "watch",
  "tig",
  "lazygit",
  "psql",
  "mysql",
  "sqlite3",
  "python",
  "python3",
  "node",
  "irb",
  "ipython",
];

const ZSH = `# --- infer shell integration (zsh) ---
export INFER_DIR="\${XDG_STATE_HOME:-$HOME/.local/state}/infer/$$"
command mkdir -p "$INFER_DIR" 2>/dev/null
command chmod 700 "$INFER_DIR" 2>/dev/null
: "\${INFER_MAX:=65536}"

# Save the real stdout/stderr so interactive programs can bypass the capture pipe.
exec {INFER_OUT_FD}>&1 {INFER_ERR_FD}>&2

# Keep colors for tools that probe isatty on the (now piped) stdout.
export CLICOLOR_FORCE=1
export FORCE_COLOR=1

_infer_denylist='${INTERACTIVE_DENYLIST.join("|")}'

_infer_capture_on() {
  exec 1> >(command tee -a "$INFER_DIR/out" >&$INFER_OUT_FD) \\
       2> >(command tee -a "$INFER_DIR/out" >&$INFER_ERR_FD)
}
_infer_capture_off() {
  exec 1>&$INFER_OUT_FD 2>&$INFER_ERR_FD
}
_infer_capture_on

autoload -Uz add-zsh-hook

_infer_preexec() {
  local cmd="$1"
  case "$cmd" in
    infer|infer\\ *) return ;;
  esac
  print -r -- "$cmd" > "$INFER_DIR/cmd"
  print -rn -- $'\\x1e' >> "$INFER_DIR/out"
  { print -r -- "cwd=$PWD"; print -r -- "shell=zsh"; } > "$INFER_DIR/meta"
  local first="\${cmd%% *}"; first="\${first##*/}"
  if [[ "$first" =~ ^(\${_infer_denylist})$ ]]; then
    INFER_SKIP=1
    _infer_capture_off
  fi
}

_infer_precmd() {
  local code=$?
  print -r -- "$code" > "$INFER_DIR/exit"
  if [[ -n "$INFER_SKIP" ]]; then
    unset INFER_SKIP
    _infer_capture_on
  fi
  if [[ -f "$INFER_DIR/out" ]]; then
    local sz
    sz=$(command wc -c < "$INFER_DIR/out" 2>/dev/null)
    if [[ -n "$sz" ]] && (( sz > INFER_MAX )); then
      command tail -c "$INFER_MAX" "$INFER_DIR/out" > "$INFER_DIR/out.tmp" 2>/dev/null \\
        && command mv "$INFER_DIR/out.tmp" "$INFER_DIR/out"
    fi
  fi
}

add-zsh-hook preexec _infer_preexec
add-zsh-hook precmd _infer_precmd

_infer_cleanup() { command rm -rf "$INFER_DIR" 2>/dev/null; }
add-zsh-hook zshexit _infer_cleanup

# Sweep stale capture dirs: any whose shell is dead, OR older than INFER_TTL_MIN
# minutes (default 1 day) regardless of liveness — bounds at-rest exposure for
# long-lived shells and guards against PID reuse.
: "\${INFER_TTL_MIN:=1440}"
command find "\${XDG_STATE_HOME:-$HOME/.local/state}/infer" -mindepth 1 -maxdepth 1 \\
  -type d -mmin +"$INFER_TTL_MIN" -exec rm -rf {} + 2>/dev/null
for _d in "\${XDG_STATE_HOME:-$HOME/.local/state}"/infer/*(N/); do
  _p=\${_d:t}
  if [[ "$_p" == <-> ]] && ! kill -0 "$_p" 2>/dev/null; then command rm -rf "$_d"; fi
done
unset _d _p

# Run the chosen fix in THIS shell so cd/export persist.
infer() {
  local out st
  out="$(INFER_WRAPPED=1 command infer "$@")"
  st=$?
  if [[ $st -eq 0 && -n "$out" ]]; then
    eval "$out"
  fi
  return $st
}
# --- end infer ---`;

const BASH = `# --- infer shell integration (bash) ---
export INFER_DIR="\${XDG_STATE_HOME:-$HOME/.local/state}/infer/$$"
command mkdir -p "$INFER_DIR" 2>/dev/null
command chmod 700 "$INFER_DIR" 2>/dev/null
: "\${INFER_MAX:=65536}"

# Fixed fd numbers (21/22) for bash 3.2 compatibility (macOS default bash).
exec 21>&1 22>&2

_infer_denylist='${INTERACTIVE_DENYLIST.join("|")}'

_infer_capture_on() {
  exec 1> >(command tee -a "$INFER_DIR/out" >&21) \\
       2> >(command tee -a "$INFER_DIR/out" >&22)
}
_infer_capture_off() { exec 1>&21 2>&22; }
_infer_capture_on

_infer_preexec() {
  local cmd="$BASH_COMMAND"
  case "$cmd" in
    infer|infer\\ *|_infer_*|__infer*) return ;;
  esac
  [[ -n "$INFER_IN_PROMPT" ]] && return
  printf '%s\\n' "$cmd" > "$INFER_DIR/cmd"
  printf '\\036' >> "$INFER_DIR/out"
  { printf 'cwd=%s\\n' "$PWD"; printf 'shell=bash\\n'; } > "$INFER_DIR/meta"
  local first="\${cmd%% *}"; first="\${first##*/}"
  if [[ "$first" =~ ^(\${_infer_denylist})$ ]]; then
    INFER_SKIP=1
    _infer_capture_off
  fi
}
trap '_infer_preexec' DEBUG

_infer_precmd() {
  local code=$?
  INFER_IN_PROMPT=1
  printf '%s\\n' "$code" > "$INFER_DIR/exit"
  if [[ -n "$INFER_SKIP" ]]; then unset INFER_SKIP; _infer_capture_on; fi
  if [[ -f "$INFER_DIR/out" ]]; then
    local sz
    sz=$(command wc -c < "$INFER_DIR/out" 2>/dev/null)
    if [[ -n "$sz" ]] && (( sz > INFER_MAX )); then
      command tail -c "$INFER_MAX" "$INFER_DIR/out" > "$INFER_DIR/out.tmp" 2>/dev/null \\
        && command mv "$INFER_DIR/out.tmp" "$INFER_DIR/out"
    fi
  fi
  unset INFER_IN_PROMPT
}
case "$PROMPT_COMMAND" in
  *_infer_precmd*) ;;
  *) PROMPT_COMMAND="_infer_precmd\${PROMPT_COMMAND:+; $PROMPT_COMMAND}" ;;
esac

# Sweep capture dirs older than INFER_TTL_MIN minutes (default 1 day) to bound
# at-rest exposure; bash has no exit hook, so rely on TTL + a cleanup on rc load.
: "\${INFER_TTL_MIN:=1440}"
command find "\${XDG_STATE_HOME:-$HOME/.local/state}/infer" -mindepth 1 -maxdepth 1 \\
  -type d -mmin +"$INFER_TTL_MIN" -exec rm -rf {} + 2>/dev/null

infer() {
  local out st
  out="$(INFER_WRAPPED=1 command infer "$@")"
  st=$?
  if [[ $st -eq 0 && -n "$out" ]]; then
    eval "$out"
  fi
  return $st
}
# --- end infer ---`;

const FISH = `# --- infer shell integration (fish) ---
set -gx INFER_DIR "$XDG_STATE_HOME/infer/"$fish_pid
test -z "$XDG_STATE_HOME"; and set -gx INFER_DIR "$HOME/.local/state/infer/"$fish_pid
command mkdir -p "$INFER_DIR" 2>/dev/null
command chmod 700 "$INFER_DIR" 2>/dev/null

# Note: fish records the command, exit code and cwd. Full output capture in fish
# relies on tmux scrollback (infer falls back automatically inside tmux).
function _infer_preexec --on-event fish_preexec
    switch $argv[1]
        case 'infer' 'infer *'
            return
    end
    printf '%s\\n' $argv[1] > "$INFER_DIR/cmd"
    printf 'cwd=%s\\nshell=fish\\n' "$PWD" > "$INFER_DIR/meta"
end

function _infer_postexec --on-event fish_postexec
    printf '%s\\n' $status > "$INFER_DIR/exit"
end

function _infer_cleanup --on-event fish_exit
    command rm -rf "$INFER_DIR" 2>/dev/null
end

# Sweep capture dirs older than INFER_TTL_MIN minutes (default 1 day).
set -q INFER_TTL_MIN; or set -g INFER_TTL_MIN 1440
set -l _infer_root (path dirname "$INFER_DIR")
command find "$_infer_root" -mindepth 1 -maxdepth 1 -type d -mmin +"$INFER_TTL_MIN" -exec rm -rf '{}' + 2>/dev/null

function infer
    set -l out (INFER_WRAPPED=1 command infer $argv)
    set -l st $status
    if test $st -eq 0; and test -n "$out"
        eval (string join \\n $out)
    end
    return $st
end
# --- end infer ---`;

/** Return the integration script for a shell. */
export function initScript(shell: SupportedShell): string {
  switch (shell) {
    case "zsh":
      return ZSH;
    case "bash":
      return BASH;
    case "fish":
      return FISH;
  }
}

/** Detect the user's shell from $SHELL; defaults to zsh. */
export function detectShell(env: NodeJS.ProcessEnv = process.env): SupportedShell {
  const sh = (env.SHELL ?? "").toLowerCase();
  if (sh.includes("fish")) return "fish";
  if (sh.includes("bash")) return "bash";
  return "zsh";
}
