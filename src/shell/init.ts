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

/**
 * Programs whose output we must NOT route through the capture pipe.
 *
 * The capture pipe makes the shell's stdout/stderr a pipe rather than a TTY.
 * Interactive REPLs, TUIs and tools that probe isatty(stdout) then misbehave —
 * they drop colors, disable line editing, or switch to non-interactive mode
 * (e.g. `claude` errors "Input must be provided…"). For these we restore the
 * real TTY for the duration of the command. infer can't meaningfully diagnose a
 * "failed command" for an interactive session anyway, so excluding them is free.
 *
 * Users extend this two more ways (both ADD to this list):
 *   - `[capture] deny = [...]` in ~/.infer.toml  (baked in per shell)
 *   - the INFER_DENY env var, space/comma separated (per shell, at runtime)
 */
const INTERACTIVE_DENYLIST = [
  // Editors
  "vim", "nvim", "vi", "vimdiff", "nano", "emacs", "hx", "helix", "kak",
  "micro", "joe", "ne", "ed", "pico",
  // Pagers, manuals
  "less", "more", "most", "man", "info",
  // System / process monitors
  "top", "htop", "btop", "atop", "glances", "bpytop", "gtop", "ctop", "nvtop",
  "ncdu", "iotop",
  // File managers
  "ranger", "nnn", "lf", "vifm", "mc", "yazi",
  // Terminal multiplexers & remote sessions
  "tmux", "screen", "zellij", "ssh", "mosh", "telnet", "ftp", "sftp",
  // Git / Docker / Kubernetes TUIs
  "tig", "lazygit", "gitui", "lazydocker", "k9s",
  // Database clients
  "psql", "mysql", "mariadb", "sqlite3", "mongo", "mongosh", "redis-cli",
  "pgcli", "mycli", "litecli",
  // Language REPLs & interactive runtimes
  "python", "python2", "python3", "bpython", "ptpython", "ipython",
  "node", "deno", "bun", "irb", "pry", "lua",
  "ghci", "iex", "erl", "clj", "clojure", "scala",
  "R", "julia", "sbcl", "racket", "guile",
  // Debuggers
  "gdb", "lldb",
  // TUI mail / chat / news / browsers
  "mutt", "neomutt", "aerc", "irssi", "weechat", "newsboat", "w3m", "lynx", "links",
  // Fuzzy finder, pickers, periodic refresh, TUI prompts
  "fzf", "watch", "dialog", "whiptail",
  // Interactive AI / agent CLIs
  "claude", "aider", "gemini", "ollama", "llm",
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

_infer_denylist='__INFER_DENYLIST__'

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
  # Self-heal: if our session dir vanished (a stale-dir sweep, a manual rm, a
  # cleared XDG state dir), recreate it and re-arm the capture pipe so we don't
  # error on every prompt. _infer_capture_on reuses the saved real-TTY fds.
  [[ -d "$INFER_DIR" ]] || { command mkdir -p "$INFER_DIR" 2>/dev/null; command chmod 700 "$INFER_DIR" 2>/dev/null; _infer_capture_on; }
  case "$cmd" in
    # infer is transparent to capture: don't record it as the "last command",
    # and tell precmd to leave the prior command's exit code untouched.
    infer|infer\\ *) INFER_SELF=1; return ;;
  esac
  print -r -- "$cmd" > "$INFER_DIR/cmd"
  print -rn -- $'\\x1e' >> "$INFER_DIR/out"
  { print -r -- "cwd=$PWD"; print -r -- "shell=zsh"; } > "$INFER_DIR/meta"
  local first="\${cmd%% *}"; first="\${first##*/}"
  local deny="$_infer_denylist"
  [[ -n "$INFER_DENY" ]] && deny="$deny|\${INFER_DENY//[ ,]/|}"
  if [[ "$first" =~ ^(\${deny})$ ]]; then
    INFER_SKIP=1
    _infer_capture_off
  fi
}

_infer_precmd() {
  local code=$?
  # Skip the exit write for infer's own invocation so a follow-up \`infer\`
  # reads the real command's status — not infer's (always 0). When a fix is
  # run, the wrapper records the fix's exit itself.
  if [[ -n "$INFER_SELF" ]]; then
    unset INFER_SELF
  else
    print -r -- "$code" > "$INFER_DIR/exit"
  fi
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

# Sweep stale capture dirs whose owning shell is GONE. A dir is reaped only when
# its name is a dead PID — NEVER an age-based delete, because deleting a still
# -alive shell's dir wedges its hooks and breaks its capture pipe for the rest
# of its life (every prompt then errors with "no such file or directory").
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
  if [[ $st -eq 0 && -n "$out" && -n "$INFER_DIR" ]]; then
    # A fix was chosen. Record it as the new "last command" and open a fresh
    # output segment, run it in THIS shell, then record ITS real exit code so a
    # follow-up \`infer\` operates on the fix's result, not infer's own status.
    print -r -- "$out" > "$INFER_DIR/cmd"
    { print -r -- "cwd=$PWD"; print -r -- "shell=zsh"; } > "$INFER_DIR/meta"
    print -rn -- $'\\x1e' >> "$INFER_DIR/out"
    eval "$out"
    st=$?
    print -r -- "$st" > "$INFER_DIR/exit"
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

_infer_denylist='__INFER_DENYLIST__'

_infer_capture_on() {
  exec 1> >(command tee -a "$INFER_DIR/out" >&21) \\
       2> >(command tee -a "$INFER_DIR/out" >&22)
}
_infer_capture_off() { exec 1>&21 2>&22; }
_infer_capture_on

_infer_preexec() {
  local cmd="$BASH_COMMAND"
  # Self-heal a vanished session dir (see zsh notes); re-arm the capture pipe.
  [[ -d "$INFER_DIR" ]] || { command mkdir -p "$INFER_DIR" 2>/dev/null; command chmod 700 "$INFER_DIR" 2>/dev/null; _infer_capture_on; }
  case "$cmd" in
    # infer is transparent to capture (see zsh notes).
    infer|infer\\ *) INFER_SELF=1; return ;;
    _infer_*|__infer*) return ;;
  esac
  [[ -n "$INFER_IN_PROMPT" ]] && return
  printf '%s\\n' "$cmd" > "$INFER_DIR/cmd"
  printf '\\036' >> "$INFER_DIR/out"
  { printf 'cwd=%s\\n' "$PWD"; printf 'shell=bash\\n'; } > "$INFER_DIR/meta"
  local first="\${cmd%% *}"; first="\${first##*/}"
  local deny="$_infer_denylist"
  [[ -n "$INFER_DENY" ]] && deny="$deny|\${INFER_DENY//[ ,]/|}"
  if [[ "$first" =~ ^(\${deny})$ ]]; then
    INFER_SKIP=1
    _infer_capture_off
  fi
}
trap '_infer_preexec' DEBUG

_infer_precmd() {
  local code=$?
  INFER_IN_PROMPT=1
  # Don't clobber the prior command's exit with infer's own (see zsh notes).
  if [[ -n "$INFER_SELF" ]]; then unset INFER_SELF; else printf '%s\\n' "$code" > "$INFER_DIR/exit"; fi
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

# Sweep stale capture dirs whose owning shell is GONE. bash has no exit hook, so
# this rc-load sweep is the cleanup. A dir is reaped only when its name is a dead
# PID — NEVER an age-based delete, which would wedge a still-alive shell.
_infer_root="\${XDG_STATE_HOME:-$HOME/.local/state}/infer"
if [[ -d "$_infer_root" ]]; then
  for _d in "$_infer_root"/*/; do
    [[ -d "$_d" ]] || continue
    _p="\${_d%/}"; _p="\${_p##*/}"
    if [[ "$_p" =~ ^[0-9]+$ ]] && ! kill -0 "$_p" 2>/dev/null; then command rm -rf "$_d"; fi
  done
fi
unset _d _p _infer_root

infer() {
  local out st
  out="$(INFER_WRAPPED=1 command infer "$@")"
  st=$?
  if [[ $st -eq 0 && -n "$out" && -n "$INFER_DIR" ]]; then
    # Record the chosen fix as the new "last command", run it here, and record
    # its real exit code (see zsh notes).
    printf '%s\\n' "$out" > "$INFER_DIR/cmd"
    { printf 'cwd=%s\\n' "$PWD"; printf 'shell=bash\\n'; } > "$INFER_DIR/meta"
    printf '\\036' >> "$INFER_DIR/out"
    eval "$out"
    st=$?
    printf '%s\\n' "$st" > "$INFER_DIR/exit"
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
            # infer is transparent to capture (see zsh notes).
            set -g INFER_SELF 1
            return
    end
    printf '%s\\n' $argv[1] > "$INFER_DIR/cmd"
    printf 'cwd=%s\\nshell=fish\\n' "$PWD" > "$INFER_DIR/meta"
end

function _infer_postexec --on-event fish_postexec
    if set -q INFER_SELF
        set -e INFER_SELF
    else
        printf '%s\\n' $status > "$INFER_DIR/exit"
    end
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
        set -l fix (string join \\n $out)
        if test -n "$INFER_DIR"
            printf '%s\\n' "$fix" > "$INFER_DIR/cmd"
            printf 'cwd=%s\\nshell=fish\\n' "$PWD" > "$INFER_DIR/meta"
        end
        eval $fix
        set st $status
        test -n "$INFER_DIR"; and printf '%s\\n' $st > "$INFER_DIR/exit"
    end
    return $st
end
# --- end infer ---`;

/**
 * Same conservative charset as the config loader. initScript is the security
 * boundary for the generated snippet, so re-validate here even though callers
 * (loadDenyList) already sanitize: entries are interpolated inside single
 * quotes AND a regex, and must not escape either.
 */
const DENY_NAME = /^[A-Za-z0-9._-]+$/;

/**
 * Return the integration script for a shell.
 *
 * @param extraDeny additional interactive commands (from `[capture] deny` in the
 *   config) to merge into the built-in denylist. Ignored for fish, which has no
 *   capture pipe and therefore no denylist. Invalid names are dropped.
 */
export function initScript(
  shell: SupportedShell,
  extraDeny: string[] = [],
): string {
  if (shell === "fish") return FISH;
  const deny = [
    ...INTERACTIVE_DENYLIST,
    ...extraDeny.filter((n) => DENY_NAME.test(n)),
  ].join("|");
  const tmpl = shell === "zsh" ? ZSH : BASH;
  return tmpl.replace("__INFER_DENYLIST__", deny);
}

/** Detect the user's shell from $SHELL; defaults to zsh. */
export function detectShell(env: NodeJS.ProcessEnv = process.env): SupportedShell {
  const sh = (env.SHELL ?? "").toLowerCase();
  if (sh.includes("fish")) return "fish";
  if (sh.includes("bash")) return "bash";
  return "zsh";
}
