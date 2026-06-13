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

  return {
    llm: provider,
    capture: { maxBytes: asNumber(capture.max_bytes, DEFAULTS.maxBytes) },
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
