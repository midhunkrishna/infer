import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createInterface } from "node:readline";
import { Command } from "commander";
import { readCapture, sessionDir } from "./capture/session.js";
import { configPath, loadConfig, redactedConfig } from "./config.js";
import { type FlowIO, runInfer } from "./flow.js";
import { LlmError } from "./llm.js";
import { detectShell, initScript, type SupportedShell } from "./shell/init.js";
import type { RunOptions } from "./types.js";

function readLine(query: string, prefill = ""): Promise<string> {
  if (!process.stdin.isTTY) return Promise.resolve("");
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  return new Promise((resolve) => {
    rl.question(query, (answer) => {
      rl.close();
      resolve(answer);
    });
    if (prefill) rl.write(prefill);
  });
}

const io: FlowIO = {
  out: (s) => process.stdout.write(s.endsWith("\n") ? s : `${s}\n`),
  err: (s) => process.stderr.write(`${s}\n`),
  prompt: (q) => readLine(q),
  promptEdit: (value) => readLine("  edit › ", value),
  run: (cmd) =>
    new Promise((resolve) => {
      const sh = process.env.SHELL || "sh";
      const child = spawn(sh, ["-c", cmd], { stdio: "inherit" });
      child.on("close", (code) => resolve(code ?? 0));
      child.on("error", () => resolve(1));
    }),
};

async function defaultAction(opts: {
  detail?: boolean;
  verbose?: boolean;
  unsafeNoRedact?: boolean;
}) {
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

function doctorAction() {
  const shell = detectShell();
  const dir =
    process.env.INFER_DIR ??
    (process.ppid ? sessionDir(process.ppid) : undefined);
  const active = Boolean(process.env.INFER_DIR) && !!dir && existsSync(dir);

  process.stderr.write(`infer doctor\n`);
  process.stderr.write(`  detected shell : ${shell}\n`);
  process.stderr.write(`  session dir    : ${dir ?? "(unknown)"}\n`);
  process.stderr.write(
    `  integration    : ${active ? "active ✓" : "NOT active ✗"}\n`,
  );
  if (!active) {
    process.stderr.write(
      `\n  Add this to your shell rc and open a new shell:\n` +
        `    eval "$(infer init ${shell})"\n`,
    );
  } else {
    process.stderr.write(
      `  config file    : ${configPath()}\n  All good — run a failing command, then \`infer\`.\n`,
    );
  }
}

function configAction() {
  const cfg = redactedConfig(loadConfig());
  process.stderr.write(`config file: ${cfg.path}\n`);
  process.stderr.write(JSON.stringify({ llm: cfg.llm, capture: cfg.capture, privacy: cfg.privacy }, null, 2) + "\n");
}

const program = new Command();
program
  .name("infer")
  .description("LLM-powered fix for your last failed shell command")
  .version("0.1.0", "-V, --version")
  .option("-d, --detail", "explain the failure and ask about your intent")
  .option("-v, --verbose", "log timing, connection and the exact LLM payload")
  .option("--unsafe-no-redact", "send WITHOUT redaction (dangerous; requires intent)")
  .action(defaultAction);

program
  .command("init")
  .argument("<shell>", "zsh | bash | fish")
  .description("print the shell integration snippet for eval")
  .action((shell: string) => {
    const s = shell as SupportedShell;
    if (s !== "zsh" && s !== "bash" && s !== "fish") {
      process.stderr.write(`infer: unsupported shell '${shell}'. Use zsh, bash or fish.\n`);
      process.exitCode = 1;
      return;
    }
    process.stdout.write(initScript(s) + "\n");
  });

program.command("doctor").description("check the shell integration").action(doctorAction);
program.command("config").description("print the resolved configuration").action(configAction);

program.parseAsync(process.argv);
