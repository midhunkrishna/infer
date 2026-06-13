import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { safeSanitize, sanitizeCwd } from "../redact.js";
import type { CaptureRecord } from "../types.js";

/** Record separator the shell hook writes between per-command output segments. */
export const SEGMENT_MARKER = "\x1e";

export interface ReadCaptureOptions {
  /** Override the session dir directly (tests). */
  dir?: string;
  /** Parent shell PID; defaults to process.ppid. */
  pid?: number;
  /** Environment to read XDG_STATE_HOME / INFER_DIR / TMUX from. */
  env?: NodeJS.ProcessEnv;
  /** Whether to scrub secrets. */
  redact?: boolean;
  /** Max bytes of output to keep after head/tail capping. */
  maxBytes?: number;
}

/** Compute the per-session state directory used by the shell integration. */
export function sessionDir(
  pid: number,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const base =
    env.XDG_STATE_HOME && env.XDG_STATE_HOME.length > 0
      ? env.XDG_STATE_HOME
      : join(homedir(), ".local", "state");
  return join(base, "infer", String(pid));
}

/** Extract the last (most recent) command's output from the ring buffer. */
export function lastSegment(raw: string): string {
  const idx = raw.lastIndexOf(SEGMENT_MARKER);
  const seg = idx === -1 ? raw : raw.slice(idx + SEGMENT_MARKER.length);
  return seg.replace(/^\n/, "");
}

function readFileSafe(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

/** Try to recover scrollback from tmux when no integration capture exists. */
function tmuxFallback(env: NodeJS.ProcessEnv): string | null {
  if (!env.TMUX) return null;
  try {
    // Small window: scrollback has a much larger blast radius than the
    // integration's single-command segment, so keep it tight.
    return execFileSync("tmux", ["capture-pane", "-p", "-S", "-40"], {
      encoding: "utf8",
      env,
    });
  } catch {
    return null;
  }
}

/**
 * Read the most recent failed command from the shell-integration session dir.
 * Returns null when nothing useful was captured (caller prints a hint).
 */
export function readCapture(
  opts: ReadCaptureOptions = {},
): CaptureRecord | null {
  const env = opts.env ?? process.env;
  const pid = opts.pid ?? process.ppid;
  const dir =
    opts.dir ?? env.INFER_DIR ?? (pid ? sessionDir(pid, env) : undefined);
  const redact = opts.redact ?? true;
  const maxBytes = opts.maxBytes ?? 16_384;

  if (dir && existsSync(join(dir, "cmd"))) {
    const command = (readFileSafe(join(dir, "cmd")) ?? "").trim();
    const exitRaw = (readFileSafe(join(dir, "exit")) ?? "").trim();
    const meta = readFileSafe(join(dir, "meta")) ?? "";
    const outRaw = readFileSafe(join(dir, "out")) ?? "";
    const rawCwd = /^cwd=(.*)$/m.exec(meta)?.[1] ?? process.cwd();
    if (command) {
      // The command line is sent to the LLM too, so it must be scrubbed —
      // people put secrets in args (curl -H, mysql -p, --token=...).
      const cmd = safeSanitize(command, { redact, maxBytes });
      const out = safeSanitize(lastSegment(outRaw), { redact, maxBytes });
      return {
        command: cmd.text,
        exitCode: Number.parseInt(exitRaw, 10) || 0,
        cwd: sanitizeCwd(rawCwd, { redact, home: env.HOME }),
        output: out.text,
        source: "integration",
        safe: cmd.ok && out.ok,
      };
    }
  }

  const pane = tmuxFallback(env);
  if (pane && pane.trim()) {
    const out = safeSanitize(pane, { redact, maxBytes });
    return {
      command: "",
      exitCode: 0,
      cwd: sanitizeCwd(process.cwd(), { redact, home: env.HOME }),
      output: out.text,
      source: "tmux",
      safe: out.ok,
    };
  }

  return null;
}
