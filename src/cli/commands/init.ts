import { loadDenyList } from "../../config.js";
import { detectShell, initScript, type SupportedShell } from "../../shell/init.js";

/**
 * `infer init [shell]`: print the shell-integration snippet for `eval`.
 *
 * With no shell argument, prints usage guidance and exits non-zero. This runs
 * on every shell startup via `eval "$(infer init …)"`, so it stays defensive.
 */
export function runInit(shell?: string): void {
  if (!shell) {
    const detected = detectShell();
    process.stderr.write(
      `Usage: eval "$(infer init ${detected})"   # add to your shell rc\n` +
        `Or simply run: infer setup\n`,
    );
    process.exitCode = 1;
    return;
  }
  const s = shell as SupportedShell;
  if (s !== "zsh" && s !== "bash" && s !== "fish") {
    process.stderr.write(`infer: unsupported shell '${shell}'. Use zsh, bash or fish.\n`);
    process.exitCode = 1;
    return;
  }
  // Merge the user's [capture] deny list from the config. loadDenyList is
  // defensive (never throws / creates files) because this runs on every
  // shell startup via `eval "$(infer init …)"`.
  process.stdout.write(initScript(s, loadDenyList()) + "\n");
}
