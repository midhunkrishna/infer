import { execFileSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { sessionDir } from "../../capture/session.js";
import { loadConfig } from "../../config.js";
import { isLocalProvider } from "../../llm.js";
import { detectShell } from "../../shell/init.js";
import { planSetup } from "../../shell/setup.js";
import type { TerminalIO } from "../io.js";

/**
 * `infer doctor`: diagnose the installation. Each check reports a ✓ or a ✗
 * (with a one-line fix). Any ✗ makes the process exit non-zero.
 */
export class Doctor {
  #failures = 0;

  constructor(private readonly io: TerminalIO) {}

  async run(): Promise<void> {
    this.io.err("infer doctor\n");
    this.#checkRuntime();
    this.#checkPathConflicts();
    this.#checkIntegrationInstalled();
    this.#checkCaptureLive();
    await this.#checkConfigAndProvider();
    this.#summarize();
  }

  #ok(msg: string): void {
    this.io.err(`  ✓ ${msg}`);
  }

  #bad(msg: string, fix: string): void {
    this.#failures++;
    this.io.err(`  ✗ ${msg}`);
    this.io.err(`      fix: ${fix}`);
  }

  /** 1. Runtime. */
  #checkRuntime(): void {
    this.#ok(`node ${process.versions.node} on ${process.platform}`);
  }

  /** 2. PATH conflicts (another tool named `infer` shadowing/shadowed). */
  #checkPathConflicts(): void {
    try {
      const all = execFileSync("which", ["-a", "infer"], { encoding: "utf8" })
        .trim()
        .split("\n")
        .filter(Boolean);
      const unique = [...new Set(all)];
      if (unique.length > 1) {
        this.#bad(
          `multiple \`infer\` binaries on PATH: ${unique.join(", ")}`,
          "another tool may win — check `which infer` matches the npm one",
        );
      } else {
        this.#ok(`infer binary: ${unique[0] ?? "(this process)"}`);
      }
    } catch {
      this.#ok("infer binary on PATH (single)");
    }
  }

  /** 3. Shell integration present in the rc file? */
  #checkIntegrationInstalled(): void {
    const shell = detectShell();
    const plan = planSetup();
    if (!plan.alreadyInstalled && !process.env.INFER_DIR) {
      this.#bad(
        `shell integration not found in ${plan.rcFile}`,
        "run `infer setup`, then open a new terminal",
      );
    } else {
      this.#ok(`integration line present for ${shell}`);
    }
  }

  /** 4. Integration live in THIS shell, and actually capturing? */
  #checkCaptureLive(): void {
    const dir =
      process.env.INFER_DIR ?? (process.ppid ? sessionDir(process.ppid) : undefined);
    if (!process.env.INFER_DIR || !dir || !existsSync(dir)) {
      this.#bad(
        "integration not active in this shell session",
        "open a NEW terminal (the rc line only takes effect in new shells)",
      );
      return;
    }
    this.#ok(`session dir: ${dir}`);
    const cmdFile = `${dir}/cmd`;
    if (!existsSync(cmdFile)) {
      this.io.err(
        "  · no command captured yet in this session — run any command, then re-check",
      );
    } else {
      const age = Math.round((Date.now() - statSync(cmdFile).mtimeMs) / 1000);
      this.#ok(`capture is live (last command recorded ${age}s ago)`);
    }
  }

  /** 5. Config parses + URL sane, and 6. provider reachable. */
  async #checkConfigAndProvider(): Promise<void> {
    let cfg: ReturnType<typeof loadConfig>;
    try {
      cfg = loadConfig();
    } catch (err) {
      this.#bad(
        `config is broken: ${(err as Error).message.split("\n")[0]}`,
        "run `infer config --reset` to regenerate safe defaults",
      );
      return;
    }
    this.#ok(`config: ${cfg.path} (provider=${cfg.llm.provider}, model=${cfg.llm.model})`);
    if (!cfg.privacy.redact) {
      this.#bad("secret redaction is DISABLED in config", "set `redact = true` under [privacy]");
    }
    // 6. Provider reachable? Any HTTP response counts; only network errors fail.
    if (isLocalProvider(cfg.llm.baseUrl)) {
      this.#ok(`provider is local (${cfg.llm.baseUrl}) — nothing leaves this machine`);
      return;
    }
    const t0 = Date.now();
    try {
      await fetch(`${cfg.llm.baseUrl}/models`, { signal: AbortSignal.timeout(5000) });
      this.#ok(`provider reachable: ${cfg.llm.baseUrl} (${Date.now() - t0}ms)`);
    } catch {
      this.#bad(
        `cannot reach ${cfg.llm.baseUrl}`,
        "check your network, or the base_url in ~/.infer.toml",
      );
    }
  }

  #summarize(): void {
    this.io.err("");
    if (this.#failures === 0) {
      this.io.err("  All good ✓ — run a failing command, then type `infer`.");
    } else {
      this.io.err(
        `  ${this.#failures} problem${this.#failures > 1 ? "s" : ""} found — apply the fixes above.`,
      );
      process.exitCode = 1;
    }
  }
}
