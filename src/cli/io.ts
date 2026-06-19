import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import type { FlowIO } from "../flow.js";

/**
 * Terminal-backed implementation of {@link FlowIO}, plus the readline plumbing
 * the CLI commands need (prompts, edit-prefill, lifecycle).
 *
 * ONE readline interface is used for the whole process. Creating a fresh
 * interface per prompt let a stray buffered newline (a double-tapped Enter, or
 * input typed during a network round-trip) be read by the NEXT prompt as an
 * empty answer — silently skipping the intent question, and even auto-running a
 * suggested fix (Enter = run). A single persistent interface emits such
 * inter-prompt lines as 'line' events with no active question, so they are
 * discarded instead.
 *
 * Methods are arrow-function properties so they stay bound when destructured
 * (e.g. `const e = io.err`), matching the original object-literal behavior.
 */
export class TerminalIO implements FlowIO {
  #rl: ReturnType<typeof createInterface> | null = null;

  /** Write to stdout — ONLY the final command to run (the wrapper evals this). */
  out = (s: string): void => {
    process.stdout.write(s.endsWith("\n") ? s : `${s}\n`);
  };

  /** Write a user-facing message (goes to the terminal, not stdout). */
  err = (s: string): void => {
    process.stderr.write(`${s}\n`);
  };

  /** Read a single line in response to a prompt. */
  prompt = (q: string): Promise<string> => this.readLine(q);

  /** Read a line pre-filled with `value` for editing. */
  promptEdit = (value: string): Promise<string> => this.readLine("  edit › ", value);

  /** Execute a command (used only when not running under the shell wrapper). */
  run = (cmd: string): Promise<number> =>
    new Promise((resolve) => {
      const sh = process.env.SHELL || "sh";
      const child = spawn(sh, ["-c", cmd], { stdio: "inherit" });
      child.on("close", (code) => resolve(code ?? 0));
      child.on("error", () => resolve(1));
    });

  /** Prompt and read one line; resolves "" immediately when not a TTY. */
  readLine = (query: string, prefill = ""): Promise<string> => {
    if (!process.stdin.isTTY) return Promise.resolve("");
    const r = this.#ensure();
    return new Promise((resolve) => {
      r.question(query, (answer) => resolve(answer));
      if (prefill) r.write(prefill);
    });
  };

  /**
   * Close the persistent readline interface. The interface keeps stdin
   * referenced, so call this once the command finishes for a clean exit.
   */
  close = (): void => {
    if (this.#rl) {
      this.#rl.close();
      this.#rl = null;
    }
  };

  #ensure(): ReturnType<typeof createInterface> {
    if (!this.#rl) {
      this.#rl = createInterface({ input: process.stdin, output: process.stderr });
    }
    return this.#rl;
  }
}
