import { readCapture } from "../../capture/session.js";
import { loadConfig } from "../../config.js";
import { runInfer } from "../../flow.js";
import { LlmError } from "../../llm.js";
import type { RunOptions } from "../../types.js";
import type { TerminalIO } from "../io.js";

/** The bare `infer` command: read the last failure and suggest a fix. */
export async function runDefault(
  io: TerminalIO,
  opts: { detail?: boolean; verbose?: boolean; unsafeNoRedact?: boolean },
): Promise<void> {
  const runOpts: RunOptions = {
    detail: Boolean(opts.detail),
    verbose: Boolean(opts.verbose),
    unsafeNoRedact: Boolean(opts.unsafeNoRedact),
  };
  try {
    await runInfer(runOpts, {
      loadConfig: () => loadConfig(),
      readCapture: (o) => readCapture(o),
      io,
      wrapped: process.env.INFER_WRAPPED === "1",
      interactive: Boolean(process.stdin.isTTY),
      llmOptions: { verbose: runOpts.verbose },
    });
  } catch (err) {
    if (err instanceof LlmError) process.stderr.write(`infer: ${err.message}\n`);
    else process.stderr.write(`infer: ${(err as Error).message}\n`);
    process.exitCode = 1;
  }
}
