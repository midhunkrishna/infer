import { ensureConfigFile } from "../../config.js";
import { applySetup, planSetup } from "../../shell/setup.js";
import type { TerminalIO } from "../io.js";

/** `infer setup`: add the shell-integration line and place the default config. */
export async function runSetup(io: TerminalIO): Promise<void> {
  const plan = planSetup();
  const e = io.err;
  e(`infer setup`);
  e(`  shell    : ${plan.shell}`);
  e(`  rc file  : ${plan.rcFile}`);
  // Place ~/.infer.toml up front. Creating an absent config with safe defaults
  // is non-destructive, so do it regardless of the rc-line outcome (or TTY).
  const cfg = ensureConfigFile();
  e(`  config   : ${cfg.path} (${cfg.created ? "created" : "exists"})`);
  if (plan.alreadyInstalled) {
    e(`\n  Already installed ✓ — open a new terminal and run \`infer doctor\`.`);
    return;
  }
  e(`  will add : ${plan.line}\n`);
  // Never modify rc files without a human explicitly confirming.
  if (!process.stdin.isTTY) {
    e("  Not a terminal — nothing changed. Run `infer setup` interactively,");
    e("  or add the line above to the rc file yourself.");
    return;
  }
  const ans = (await io.readLine("  Add this line? [Y/n] ")).trim().toLowerCase();
  if (ans === "n" || ans === "no" || ans === "q") {
    e("  Nothing changed. Add the line above manually whenever you like.");
    return;
  }
  applySetup(plan);
  e(`\n  Done ✓  Open a NEW terminal, run a failing command, then type \`infer\`.`);
}
