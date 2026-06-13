import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parse } from "smol-toml";
import type { InferConfig, ProviderConfig } from "./types.js";

/** Default config file contents, written on first run. */
export const DEFAULT_CONFIG_TOML = `# infer-cmd configuration
# Works out of the box with the free LLM7.io endpoint (no API key needed).
# To switch providers, change base_url / model / api_key below. See the README.

[llm]
provider = "llm7"
base_url = "https://api.llm7.io/v1"
model    = "gpt-4.1-nano"
api_key  = ""              # not required for llm7; can also use INFER_API_KEY env

[llm.params]
temperature = 0.2
max_tokens  = 512

[capture]
max_bytes = 65536          # max bytes of command output kept / sent
# Commands to exclude from output capture because they need a real TTY
# (interactive REPLs/TUIs that misbehave when stdout is a pipe). These are
# ADDED to the built-in list (vim, less, ssh, claude, …). You can also extend
# it per-shell at runtime with the INFER_DENY env var.
# deny = ["mytool", "anothertool"]

[privacy]
redact = true              # scrub secrets (keys, tokens, passwords) before any network call
`;

const DEFAULTS = {
  provider: "llm7",
  baseUrl: "https://api.llm7.io/v1",
  model: "gpt-4.1-nano",
  apiKey: "",
  temperature: 0.2,
  maxTokens: 512,
  maxBytes: 65536,
  redact: true,
};

/** Resolve the config file path (honoring INFER_CONFIG override). */
export function configPath(env: NodeJS.ProcessEnv = process.env): string {
  return env.INFER_CONFIG ?? join(homedir(), ".infer.toml");
}

function asNumber(v: unknown, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

function asString(v: unknown, fallback: string): string {
  return typeof v === "string" ? v : fallback;
}

/**
 * Conservative command-name charset. The denylist is interpolated into the
 * shell snippet (inside single quotes) AND into a `[[ =~ ]]` regex, so entries
 * must not be able to escape the quoting or inject regex metacharacters. We
 * accept only what real command basenames use; anything else is dropped.
 */
const DENY_NAME = /^[A-Za-z0-9._-]+$/;

function sanitizeDeny(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === "string" && DENY_NAME.test(x));
}

/**
 * Read ONLY the capture denylist from the config file, defensively.
 *
 * `infer init` runs on every shell startup (via `eval`), so unlike loadConfig
 * this must NEVER throw and must NEVER create the file — a config typo must not
 * break the user's shell. Missing/invalid config simply yields no extra entries.
 */
export function loadDenyList(env: NodeJS.ProcessEnv = process.env): string[] {
  try {
    const path = configPath(env);
    if (!existsSync(path)) return [];
    const data = parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    const capture = (data.capture ?? {}) as Record<string, unknown>;
    return sanitizeDeny(capture.deny);
  } catch {
    return [];
  }
}

/**
 * Load config, generating the default file on first run. Applies env overrides:
 * INFER_API_KEY wins over the file's api_key.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): InferConfig {
  const path = configPath(env);
  let raw = "";
  if (existsSync(path)) {
    raw = readFileSync(path, "utf8");
  } else {
    writeFileSync(path, DEFAULT_CONFIG_TOML, { mode: 0o600 });
    raw = DEFAULT_CONFIG_TOML;
  }

  let data: Record<string, unknown>;
  try {
    data = parse(raw) as Record<string, unknown>;
  } catch (err) {
    throw new Error(
      `Failed to parse ${path}: ${(err as Error).message}. ` +
        `Fix the TOML or delete the file to regenerate defaults.`,
    );
  }

  const llm = (data.llm ?? {}) as Record<string, unknown>;
  const params = (llm.params ?? {}) as Record<string, unknown>;
  const capture = (data.capture ?? {}) as Record<string, unknown>;
  const privacy = (data.privacy ?? {}) as Record<string, unknown>;

  const provider: ProviderConfig = {
    provider: asString(llm.provider, DEFAULTS.provider),
    baseUrl: asString(llm.base_url, DEFAULTS.baseUrl).replace(/\/+$/, ""),
    model: asString(llm.model, DEFAULTS.model),
    apiKey:
      env.INFER_API_KEY && env.INFER_API_KEY.length > 0
        ? env.INFER_API_KEY
        : asString(llm.api_key, DEFAULTS.apiKey),
    temperature: asNumber(params.temperature, DEFAULTS.temperature),
    maxTokens: asNumber(params.max_tokens, DEFAULTS.maxTokens),
  };

  // Fail at load time with the bad value shown, not later as a cryptic
  // fetch error.
  if (!/^https?:\/\//i.test(provider.baseUrl)) {
    throw new Error(
      `Invalid base_url "${provider.baseUrl}" in ${path} — it must be a full ` +
        `http(s) URL like "https://api.llm7.io/v1". Run \`infer config --reset\` to restore defaults.`,
    );
  }
  try {
    new URL(provider.baseUrl);
  } catch {
    throw new Error(
      `Invalid base_url "${provider.baseUrl}" in ${path} — not a parseable URL. ` +
        `Run \`infer config --reset\` to restore defaults.`,
    );
  }

  return {
    llm: provider,
    capture: {
      maxBytes: asNumber(capture.max_bytes, DEFAULTS.maxBytes),
      deny: sanitizeDeny(capture.deny),
    },
    privacy: {
      redact: typeof privacy.redact === "boolean" ? privacy.redact : DEFAULTS.redact,
    },
    path,
  };
}

/** Produce a display copy of config with the api key masked. */
export function redactedConfig(cfg: InferConfig): InferConfig {
  return {
    ...cfg,
    llm: {
      ...cfg.llm,
      apiKey: cfg.llm.apiKey ? "‹set›" : "",
    },
  };
}
