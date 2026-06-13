/**
 * Classifies an LLM-suggested fix before it is run (or emitted to the shell
 * wrapper, which `eval`s it). Three levels:
 *
 *  - "reject":  structurally unsafe to eval at all (multi-line, command
 *               substitution). Error output is attacker-influencable, so a
 *               prompt-injected model could smuggle arbitrary code here.
 *  - "danger":  legitimate shape but destructive intent — requires the user
 *               to type the full word "yes".
 *  - "safe":    normal confirm flow.
 */

export interface CommandVerdict {
  level: "safe" | "danger" | "reject";
  reason: string;
}

/** Destructive patterns, tested against each segment of a chained command. */
const DANGER_PATTERNS: Array<[RegExp, string]> = [
  [/^\s*sudo\b/, "runs with sudo"],
  [/\brm\b[^|;&]*(-[a-z]*r[a-z]*f|-[a-z]*f[a-z]*r)\b/, "recursive force delete (rm -rf)"],
  [/\brm\b.*\s(\/|~\/?)(\s|$)/, "deletes / or ~"],
  [/\bdd\b.*\bof=/, "raw disk/file write (dd of=…)"],
  [/\bmkfs(\.|\b)/, "formats a filesystem"],
  [/\bshutdown\b|\breboot\b|\bhalt\b/, "shuts down or reboots the machine"],
  [/\bgit\s+push\b.*(\s--force\b|\s-f\b)/, "force-push (rewrites remote history)"],
  [/\bgit\s+reset\s+--hard\b/, "discards local changes (git reset --hard)"],
  [/\bgit\s+clean\b.*-[a-z]*f/, "deletes untracked files (git clean -f)"],
  [/\bchmod\b.*\b777\b/, "world-writable permissions (chmod 777)"],
  [/\bchown\b.*-[a-z]*R/, "recursive ownership change"],
  [/\bkubectl\s+delete\b/, "deletes Kubernetes resources"],
  [/\bterraform\s+(destroy|apply\s+-auto-approve)\b/, "destroys/applies infrastructure without review"],
  [/\bdocker\s+(system\s+prune|rm|rmi)\b.*(-f|--force|-a|--all)/, "force-removes Docker data"],
  [/\bnpm\s+publish\b|\byarn\s+publish\b/, "publishes a package to a public registry"],
  [/\bkill\b.*\s-9?\s*1\b/, "kills PID 1"],
  [/:\(\)\s*\{/, "fork bomb"],
  [/>\s*\/dev\/(sd|nvme|disk)/, "writes directly to a disk device"],
  [/\btruncate\b.*\s-s\s*0/, "truncates files to zero"],
  [/\bDROP\s+(TABLE|DATABASE)\b/i, "drops a database table/schema"],
];

/** A pipe into a shell = remote code execution pattern (curl … | sh). */
const PIPE_TO_SHELL = /\|\s*(sudo\s+)?(ba|z|da|k)?sh\b/;

/** Split a command line on chain operators so each part is checked. */
function segments(cmd: string): string[] {
  return cmd.split(/\|\||&&|;|\|/).map((s) => s.trim()).filter(Boolean);
}

export function assessCommand(cmd: string): CommandVerdict {
  const trimmed = cmd.trim();

  // Structural rejections: these have no business coming from a "fixed
  // command" suggestion, and the shell wrapper would eval them blindly.
  if (/\r|\n/.test(trimmed)) {
    return { level: "reject", reason: "multi-line command" };
  }
  if (/\$\(/.test(trimmed) || /`/.test(trimmed)) {
    return { level: "reject", reason: "embedded command substitution ($(…) or backticks)" };
  }

  if (PIPE_TO_SHELL.test(trimmed)) {
    return { level: "danger", reason: "pipes downloaded/garbage content into a shell" };
  }

  for (const seg of segments(trimmed)) {
    for (const [re, reason] of DANGER_PATTERNS) {
      if (re.test(seg)) return { level: "danger", reason };
    }
  }

  return { level: "safe", reason: "" };
}
