import { spawn, execFileSync } from "node:child_process";
import { copyFileSync, existsSync, statSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { Command } from "commander";
import { readCapture, sessionDir } from "./capture/session.js";
import {
  configPath,
  DEFAULT_CONFIG_TOML,
  loadConfig,
  loadDenyList,
  redactedConfig,
} from "./config.js";
import { type FlowIO, runInfer } from "./flow.js";
import { isLocalProvider, LlmError } from "./llm.js";
import { detectShell, initScript, type SupportedShell } from "./shell/init.js";
import { applySetup, planSetup } from "./shell/setup.js";
import type { RunOptions } from "./types.js";

// ---- Hard environment guards (clear words instead of stack traces) --------
const nodeMajor = Number(process.versions.node.split(".")[0]);
if (Number.isFinite(nodeMajor) && nodeMajor < 18) {
  process.stderr.write(
    `infer: Node ${process.versions.node} is too old — version 18 or newer is required.\n` +
      `Upgrade Node (https://nodejs.org) and reinstall: npm i -g infer-cmd\n`,
  );
  process.exit(1);
}
if (process.platform === "win32") {
  process.stderr.write(
    "infer: native Windows isn't supported — the shell integration needs zsh/bash/fish.\n" +
      "It works great under WSL: https://learn.microsoft.com/windows/wsl/install\n",
  );
  process.exit(1);
}

// ONE readline interface for the whole process. Creating a fresh interface per
// prompt let a stray buffered newline (a double-tapped Enter, or input typed
// during a network round-trip) be read by the NEXT prompt as an empty answer —
// silently skipping the intent question, and even auto-running a suggested fix
// (Enter = run). A single persistent interface emits such inter-prompt lines as
// 'line' events with no active question, so they are discarded instead.
let sharedRl: ReturnType<typeof createInterface> | null = null;
function rl(): ReturnType<typeof createInterface> {
  if (!sharedRl) {
    sharedRl = createInterface({ input: process.stdin, output: process.stderr });
  }
  return sharedRl;
}
function closeReadline(): void {
  if (sharedRl) {
    sharedRl.close();
    sharedRl = null;
  }
}

function readLine(query: string, prefill = ""): Promise<string> {
  if (!process.stdin.isTTY) return Promise.resolve("");
  const r = rl();
  return new Promise((resolve) => {
    r.question(query, (answer) => resolve(answer));
    if (prefill) r.write(prefill);
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

// ---- infer setup -----------------------------------------------------------
async function setupAction() {
  const plan = planSetup();
  const e = io.err;
  e(`infer setup`);
  e(`  shell    : ${plan.shell}`);
  e(`  rc file  : ${plan.rcFile}`);
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
  const ans = (await readLine("  Add this line? [Y/n] ")).trim().toLowerCase();
  if (ans === "n" || ans === "no" || ans === "q") {
    e("  Nothing changed. Add the line above manually whenever you like.");
    return;
  }
  applySetup(plan);
  e(`\n  Done ✓  Open a NEW terminal, run a failing command, then type \`infer\`.`);
}

// ---- infer doctor ----------------------------------------------------------
async function doctorAction() {
  const e = io.err;
  let failures = 0;
  const ok = (msg: string) => e(`  ✓ ${msg}`);
  const bad = (msg: string, fix: string) => {
    failures++;
    e(`  ✗ ${msg}`);
    e(`      fix: ${fix}`);
  };

  e("infer doctor\n");

  // 1. Runtime
  ok(`node ${process.versions.node} on ${process.platform}`);

  // 2. PATH conflicts (another tool named `infer` shadowing/shadowed)
  try {
    const all = execFileSync("which", ["-a", "infer"], { encoding: "utf8" })
      .trim()
      .split("\n")
      .filter(Boolean);
    const unique = [...new Set(all)];
    if (unique.length > 1) {
      bad(
        `multiple \`infer\` binaries on PATH: ${unique.join(", ")}`,
        "another tool may win — check `which infer` matches the npm one",
      );
    } else {
      ok(`infer binary: ${unique[0] ?? "(this process)"}`);
    }
  } catch {
    ok("infer binary on PATH (single)");
  }

  // 3. Shell integration present?
  const shell = detectShell();
  const plan = planSetup();
  if (!plan.alreadyInstalled && !process.env.INFER_DIR) {
    bad(
      `shell integration not found in ${plan.rcFile}`,
      "run `infer setup`, then open a new terminal",
    );
  } else {
    ok(`integration line present for ${shell}`);
  }

  // 4. Integration live in THIS shell, and actually capturing?
  const dir =
    process.env.INFER_DIR ?? (process.ppid ? sessionDir(process.ppid) : undefined);
  if (!process.env.INFER_DIR || !dir || !existsSync(dir)) {
    bad(
      "integration not active in this shell session",
      "open a NEW terminal (the rc line only takes effect in new shells)",
    );
  } else {
    ok(`session dir: ${dir}`);
    const cmdFile = `${dir}/cmd`;
    if (!existsSync(cmdFile)) {
      e("  · no command captured yet in this session — run any command, then re-check");
    } else {
      const age = Math.round((Date.now() - statSync(cmdFile).mtimeMs) / 1000);
      ok(`capture is live (last command recorded ${age}s ago)`);
    }
  }

  // 5. Config parses + URL sane
  let cfgOk = false;
  try {
    const cfg = loadConfig();
    cfgOk = true;
    ok(`config: ${cfg.path} (provider=${cfg.llm.provider}, model=${cfg.llm.model})`);
    if (!cfg.privacy.redact) {
      bad("secret redaction is DISABLED in config", "set `redact = true` under [privacy]");
    }
    // 6. Provider reachable? Any HTTP response counts; only network errors fail.
    if (isLocalProvider(cfg.llm.baseUrl)) {
      ok(`provider is local (${cfg.llm.baseUrl}) — nothing leaves this machine`);
    } else {
      const t0 = Date.now();
      try {
        await fetch(`${cfg.llm.baseUrl}/models`, {
          signal: AbortSignal.timeout(5000),
        });
        ok(`provider reachable: ${cfg.llm.baseUrl} (${Date.now() - t0}ms)`);
      } catch {
        bad(
          `cannot reach ${cfg.llm.baseUrl}`,
          "check your network, or the base_url in ~/.infer.toml",
        );
      }
    }
  } catch (err) {
    bad(
      `config is broken: ${(err as Error).message.split("\n")[0]}`,
      "run `infer config --reset` to regenerate safe defaults",
    );
  }

  e("");
  if (failures === 0) {
    e("  All good ✓ — run a failing command, then type `infer`.");
  } else {
    e(`  ${failures} problem${failures > 1 ? "s" : ""} found — apply the fixes above.`);
    process.exitCode = 1;
  }
  void cfgOk;
}

// ---- infer config ----------------------------------------------------------
function configAction(opts: { reset?: boolean }) {
  const path = configPath();
  if (opts.reset) {
    if (existsSync(path)) {
      copyFileSync(path, `${path}.bak`);
      io.err(`backed up old config to ${path}.bak`);
    }
    writeFileSync(path, DEFAULT_CONFIG_TOML, { mode: 0o600 });
    io.err(`wrote fresh defaults to ${path}`);
    return;
  }
  const cfg = redactedConfig(loadConfig());
  io.err(`config file: ${cfg.path}`);
  io.err(
    JSON.stringify({ llm: cfg.llm, capture: cfg.capture, privacy: cfg.privacy }, null, 2),
  );
}

// ---- commander wiring ------------------------------------------------------
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
  .command("setup")
  .description("install the shell integration into your shell rc (one line)")
  .action(setupAction);

program
  .command("init")
  .argument("[shell]", "zsh | bash | fish")
  .description("print the shell integration snippet for eval")
  .action((shell?: string) => {
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
      process.stderr.write(
        `infer: unsupported shell '${shell}'. Use zsh, bash or fish.\n`,
      );
      process.exitCode = 1;
      return;
    }
    // Merge the user's [capture] deny list from the config. loadDenyList is
    // defensive (never throws / creates files) because this runs on every
    // shell startup via `eval "$(infer init …)"`.
    process.stdout.write(initScript(s, loadDenyList()) + "\n");
  });

program
  .command("doctor")
  .description("diagnose the installation; non-zero exit if anything is broken")
  .action(doctorAction);

program
  .command("config")
  .description("print the resolved configuration")
  .option("--reset", "back up and regenerate the default config file")
  .action(configAction);

// The persistent readline interface keeps stdin referenced; close it once the
// command finishes so the process can exit cleanly.
program.parseAsync(process.argv).finally(closeReadline);
