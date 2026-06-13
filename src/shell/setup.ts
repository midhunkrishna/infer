import { existsSync, mkdirSync, readFileSync, appendFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { detectShell, type SupportedShell } from "./init.js";

export interface SetupPlan {
  shell: SupportedShell;
  rcFile: string;
  /** The exact line that will be appended. */
  line: string;
  /** True when the rc file already references the integration. */
  alreadyInstalled: boolean;
}

/**
 * The rc line is guarded with `command -v` so that uninstalling the package
 * never breaks the user's shell startup.
 */
function rcLine(shell: SupportedShell): string {
  if (shell === "fish") return `command -q infer; and infer init fish | source`;
  return `command -v infer >/dev/null && eval "$(infer init ${shell})"`;
}

/** Resolve the right rc file per shell, honoring ZDOTDIR / XDG. */
export function rcFileFor(
  shell: SupportedShell,
  env: NodeJS.ProcessEnv = process.env,
  home = homedir(),
  platform: NodeJS.Platform = process.platform,
): string {
  switch (shell) {
    case "zsh":
      return join(env.ZDOTDIR && env.ZDOTDIR.length > 0 ? env.ZDOTDIR : home, ".zshrc");
    case "bash":
      // macOS terminals open login shells, which read .bash_profile.
      return join(home, platform === "darwin" ? ".bash_profile" : ".bashrc");
    case "fish": {
      const cfg = env.XDG_CONFIG_HOME && env.XDG_CONFIG_HOME.length > 0
        ? env.XDG_CONFIG_HOME
        : join(home, ".config");
      return join(cfg, "fish", "config.fish");
    }
  }
}

/** Build the (idempotent) setup plan without touching anything. */
export function planSetup(
  env: NodeJS.ProcessEnv = process.env,
  home = homedir(),
  platform: NodeJS.Platform = process.platform,
): SetupPlan {
  const shell = detectShell(env);
  const rcFile = rcFileFor(shell, env, home, platform);
  const line = rcLine(shell);
  let alreadyInstalled = false;
  if (existsSync(rcFile)) {
    const content = readFileSync(rcFile, "utf8");
    alreadyInstalled = content.includes(`infer init ${shell}`);
  }
  return { shell, rcFile, line, alreadyInstalled };
}

/** Append the integration line (creates parent dirs / the rc file if needed). */
export function applySetup(plan: SetupPlan): void {
  mkdirSync(dirname(plan.rcFile), { recursive: true });
  const prefix = existsSync(plan.rcFile) && !readFileSync(plan.rcFile, "utf8").endsWith("\n")
    ? "\n"
    : "";
  appendFileSync(plan.rcFile, `${prefix}\n# infer-cmd shell integration\n${plan.line}\n`);
}
