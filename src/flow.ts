import { assessCommand } from "./danger.js";
import type { LlmCallOptions } from "./llm.js";
import {
  isLocalProvider,
  previewPayload,
  providerHost,
  requestDetail,
  requestFix,
  requestRefine,
} from "./llm.js";
import { safeSanitize } from "./redact.js";
import type {
  CaptureRecord,
  InferConfig,
  ProviderConfig,
  RunOptions,
} from "./types.js";

/** I/O surface, injected so the flow is fully testable. */
export interface FlowIO {
  /** Write to stdout — ONLY the final command to run (the wrapper evals this). */
  out: (s: string) => void;
  /** Write a user-facing message (goes to the terminal, not stdout). */
  err: (s: string) => void;
  /** Read a single line in response to a prompt. */
  prompt: (q: string) => Promise<string>;
  /** Read a line pre-filled with `value` for editing. */
  promptEdit: (value: string) => Promise<string>;
  /** Execute a command (used only when not running under the shell wrapper). */
  run: (cmd: string) => Promise<number>;
}

export interface FlowDeps {
  loadConfig: () => InferConfig;
  readCapture: (o: {
    redact: boolean;
    maxBytes: number;
  }) => CaptureRecord | null;
  io: FlowIO;
  /** True when invoked via the shell wrapper (chosen cmd can run in-shell). */
  wrapped: boolean;
  /** True when a human is present to confirm (TTY). Off → never auto-run. */
  interactive: boolean;
  /** Override the LLM functions (tests). */
  llm?: {
    requestFix: typeof requestFix;
    requestDetail: typeof requestDetail;
    requestRefine: typeof requestRefine;
  };
  llmOptions?: LlmCallOptions;
}

const NO_CAPTURE_HINT = `infer: no recent command was captured.

The one-time shell integration isn't active in this shell. To fix:

  infer setup        # adds one line to your shell rc for you

then open a NEW terminal, run any failing command, and type \`infer\`.
(\`infer doctor\` shows a full health check.)`;

/** Present a fix and let the user run / edit / quit. */
async function present(
  cmd: string,
  deps: FlowDeps,
): Promise<void> {
  const { io } = deps;

  // Firewall for the eval path: error output is attacker-influencable, so a
  // structurally suspicious "fix" is never offered for execution at all.
  const verdict = assessCommand(cmd);
  if (verdict.level === "reject") {
    io.err(
      `\n  ⛔ The suggested fix was blocked (${verdict.reason}) — showing it for\n` +
        `     reference only, it will NOT be offered to run:\n\n  ${cmd}`,
    );
    return;
  }

  io.err(`\n  → ${cmd}\n`);

  // No human to confirm (piped/CI): show the suggestion, never run it. In
  // wrapped mode stdout gets eval'd by the shell function, so use stderr.
  if (!deps.interactive) {
    if (deps.wrapped) io.err(`  (not run — no TTY to confirm)`);
    else io.out(cmd);
    return;
  }

  let final = cmd;
  if (verdict.level === "danger") {
    io.err(`  ⚠️  This command ${verdict.reason}.`);
    const typed = (await io.prompt("  Type 'yes' to run it, anything else cancels: "))
      .trim()
      .toLowerCase();
    if (typed !== "yes") {
      io.err("  Cancelled.");
      return;
    }
  } else {
    const ans = (await io.prompt("  [Enter=run · e=edit · q=quit] "))
      .trim()
      .toLowerCase();
    if (ans === "e") {
      final = (await io.promptEdit(cmd)).trim();
      if (!final) return;
    } else if (ans !== "" && ans !== "y" && ans !== "yes") {
      // Default-safe: ANY unrecognized answer ("no", "wtf", a typo) cancels.
      io.err("  Cancelled.");
      return;
    }
  }

  if (deps.wrapped) io.out(final);
  else await io.run(final);
}

/**
 * Fail-closed gate that runs BEFORE any bytes leave the machine. Returns true
 * only when it is safe to send. Local providers skip the network consent step.
 */
async function gateSend(
  cfg: ProviderConfig,
  capture: CaptureRecord,
  deps: FlowDeps,
  redaction: { enabled: boolean; flagged: boolean },
): Promise<boolean> {
  // 1. Redaction must have succeeded and verified clean (when enabled).
  if (redaction.enabled && !capture.safe) {
    deps.io.err(
      "\n  ⛔ Refusing to send: the captured text still looks like it contains a\n" +
        "     secret after redaction. Nothing was sent. Re-run after clearing the\n" +
        "     sensitive output, or use a local model (base_url = http://localhost…).",
    );
    return false;
  }

  // 2. Local provider → nothing leaves the machine; no consent needed.
  if (isLocalProvider(cfg.baseUrl)) return true;

  const host = providerHost(cfg.baseUrl);

  // 2b. Redaction disabled + remote: never silent. Require explicit flag + banner.
  if (!redaction.enabled) {
    if (!redaction.flagged) {
      deps.io.err(
        `\n  ⛔ Redaction is disabled but ${host} is remote. Refusing to send raw.\n` +
          "     Re-enable [privacy] redact, use a local model, or pass\n" +
          "     --unsafe-no-redact to send unredacted ON PURPOSE.",
      );
      return false;
    }
    deps.io.err(
      `\n  ⚠️  REDACTION DISABLED — raw command + output will be sent to ${host}.`,
    );
  }

  // 3. No human present → never silently ship to a third party.
  if (!deps.interactive) {
    deps.io.err(
      `\n  ⛔ Refusing to send to ${host} without confirmation (non-interactive).\n` +
        "     Run infer in an interactive shell, or configure a local model.",
    );
    return false;
  }

  // 4. Show the EXACT payload and require explicit consent.
  deps.io.err(`\n  The following will be sent to ${host}:`);
  deps.io.err("  ┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄");
  for (const line of previewPayload(capture).split("\n")) deps.io.err(`  │ ${line}`);
  deps.io.err("  ┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄");
  const ans = (await deps.io.prompt(`  Send this to ${host}? [y/N] `))
    .trim()
    .toLowerCase();
  if (ans !== "y" && ans !== "yes") {
    deps.io.err("  Not sent.");
    return false;
  }
  return true;
}

async function detailFlow(
  cfg: ProviderConfig,
  capture: CaptureRecord,
  deps: FlowDeps,
): Promise<void> {
  const llm = deps.llm ?? { requestDetail, requestRefine, requestFix };
  const detail = await llm.requestDetail(cfg, capture, deps.llmOptions);

  deps.io.err(`\n  Why it failed:\n    ${detail.why}`);
  if (detail.alternatives.length) {
    deps.io.err("\n  Other options:");
    for (const a of detail.alternatives) deps.io.err(`    • ${a}`);
  }
  deps.io.err(`\n  ${detail.intentQuestion}`);
  const answer = await deps.io.prompt("  > ");
  if (!answer.trim()) {
    deps.io.err("\n  No answer given — nothing to refine.");
    return;
  }
  // The answer is sent too — scrub it (people paste tokens into answers).
  const safeAnswer = safeSanitize(answer);
  if (!safeAnswer.ok) {
    deps.io.err("\n  ⛔ Your answer looks like it contains a secret — not sending.");
    return;
  }
  const fix = await llm.requestRefine(
    cfg,
    capture,
    detail.intentQuestion,
    safeAnswer.text,
    deps.llmOptions,
  );
  if (fix) await present(fix, deps);
  else deps.io.err("\n  Sorry — still couldn't determine a fix.");
}

/** Entry point for the `infer` command. */
export async function runInfer(
  opts: RunOptions,
  deps: FlowDeps,
): Promise<void> {
  const cfg = deps.loadConfig();
  const redactEnabled = cfg.privacy.redact && !opts.unsafeNoRedact;
  const capture = deps.readCapture({
    redact: redactEnabled,
    maxBytes: cfg.capture.maxBytes,
  });

  if (!capture) {
    deps.io.err(NO_CAPTURE_HINT);
    return;
  }
  if (capture.exitCode === 0 && capture.source === "integration" && !opts.detail) {
    deps.io.err(
      `\n  The last command (\`${capture.command}\`) exited 0 — nothing to fix.`,
    );
    return;
  }

  // Fail-closed gate: nothing leaves the machine before this returns true.
  if (
    !(await gateSend(cfg.llm, capture, deps, {
      enabled: redactEnabled,
      flagged: Boolean(opts.unsafeNoRedact),
    }))
  )
    return;

  const llm = deps.llm ?? { requestFix, requestDetail, requestRefine };

  if (opts.detail) {
    await detailFlow(cfg.llm, capture, deps);
    return;
  }

  const result = await llm.requestFix(cfg.llm, capture, deps.llmOptions);
  if (result.confident && result.fix) {
    if (result.reason) deps.io.err(`  ${result.reason}`);
    await present(result.fix, deps);
  } else {
    // Could not confidently fix → fall through to the detail flow.
    deps.io.err(
      `  ${result.reason || "Couldn't determine a confident fix — here are details."}`,
    );
    await detailFlow(cfg.llm, capture, deps);
  }
}
