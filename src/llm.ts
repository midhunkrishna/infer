import type {
  CaptureRecord,
  LlmDetailResult,
  LlmFixResult,
  ProviderConfig,
} from "./types.js";

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface LlmCallOptions {
  verbose?: boolean;
  /** Sink for verbose logs; defaults to stderr. */
  log?: (msg: string) => void;
  /** Injectable fetch for tests. */
  fetchImpl?: typeof fetch;
}

/** Raised for non-2xx responses so the CLI can render a friendly message. */
export class LlmError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "LlmError";
  }
}

const FIX_SYSTEM = `You are a shell expert. The user ran a command that failed.
Given the command, exit code, working directory and error output, return the single corrected command that the user most likely intended.
Reply with ONLY a JSON object, no prose, no markdown fences:
{"fix": string|null, "confident": boolean, "reason": string}
- "fix": the corrected command line, or null if you cannot determine one.
- "confident": true only if you are reasonably sure the fix is correct.
- "reason": one short sentence explaining the fix or why none is possible.`;

const DETAIL_SYSTEM = `You are a shell expert helping diagnose a failed command.
Given the command, exit code, working directory and error output, reply with ONLY a JSON object, no prose, no markdown fences:
{"why": string, "alternatives": string[], "intentQuestion": string}
- "why": a concise explanation of why the command failed.
- "alternatives": up to 4 other commands or options the user might have meant.
- "intentQuestion": one clarifying question about what the user was trying to do.`;

const REFINE_SYSTEM = `You are a shell expert. Using the original failed command, its error, and the user's answer to your clarifying question, return the corrected command.
Reply with ONLY a JSON object, no prose, no markdown fences:
{"fix": string, "reason": string}`;

function contextBlock(c: CaptureRecord): string {
  const parts = [
    `Command: ${c.command || "(unknown — recovered from terminal scrollback)"}`,
    `Exit code: ${c.exitCode}`,
    `Working directory: ${c.cwd}`,
    `Platform: ${process.platform}`,
    "",
    "Output:",
    c.output || "(no output captured)",
  ];
  return parts.join("\n");
}

/** Human-readable preview of exactly what context will be sent to the LLM. */
export function previewPayload(c: CaptureRecord): string {
  return contextBlock(c);
}

/** True when the provider runs on this machine (no network egress). */
export function isLocalProvider(baseUrl: string): boolean {
  try {
    const h = new URL(baseUrl).hostname.toLowerCase();
    return (
      h === "localhost" ||
      h === "127.0.0.1" ||
      h === "::1" ||
      h === "0.0.0.0" ||
      h.endsWith(".local")
    );
  } catch {
    return false;
  }
}

/** Host shown in the consent prompt. */
export function providerHost(baseUrl: string): string {
  try {
    return new URL(baseUrl).host;
  } catch {
    return baseUrl;
  }
}

export function buildFixMessages(c: CaptureRecord): ChatMessage[] {
  return [
    { role: "system", content: FIX_SYSTEM },
    { role: "user", content: contextBlock(c) },
  ];
}

export function buildDetailMessages(c: CaptureRecord): ChatMessage[] {
  return [
    { role: "system", content: DETAIL_SYSTEM },
    { role: "user", content: contextBlock(c) },
  ];
}

export function buildRefineMessages(
  c: CaptureRecord,
  question: string,
  answer: string,
): ChatMessage[] {
  return [
    { role: "system", content: REFINE_SYSTEM },
    { role: "user", content: contextBlock(c) },
    { role: "assistant", content: question },
    { role: "user", content: answer },
  ];
}

/**
 * Tolerantly parse a JSON object from a model reply: handles ```json fences and
 * leading/trailing prose by extracting the outermost {...} block.
 */
export function parseJsonReply<T>(text: string): T | null {
  if (!text) return null;
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  const candidate = fenced ? fenced[1]! : text;
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) return null;
  try {
    return JSON.parse(candidate.slice(start, end + 1)) as T;
  } catch {
    return null;
  }
}

/** Low-level OpenAI-compatible chat completion call. */
export async function chat(
  cfg: ProviderConfig,
  messages: ChatMessage[],
  opts: LlmCallOptions = {},
): Promise<string> {
  const log = opts.log ?? ((m) => process.stderr.write(`${m}\n`));
  const doFetch = opts.fetchImpl ?? globalThis.fetch;
  const url = `${cfg.baseUrl}/chat/completions`;
  const body = {
    model: cfg.model,
    messages,
    temperature: cfg.temperature,
    max_tokens: cfg.maxTokens,
  };

  if (opts.verbose) {
    log(`[infer] provider=${cfg.provider} model=${cfg.model}`);
    log(`[infer] POST ${url} (api_key=${cfg.apiKey ? "set" : "none"})`);
    log(`[infer] payload (redaction already applied):`);
    log(JSON.stringify(body, null, 2));
  }

  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (cfg.apiKey) headers.Authorization = `Bearer ${cfg.apiKey}`;

  const started = Date.now();
  let res: Response;
  try {
    res = await doFetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
  } catch (err) {
    const code = String(
      (err as { cause?: { code?: string } })?.cause?.code ?? "",
    );
    if (code === "ENOTFOUND" || code === "EAI_AGAIN") {
      throw new LlmError(
        `Cannot resolve ${new URL(url).host} — you appear to be offline, or the ` +
          `base_url in ~/.infer.toml has a typo.`,
      );
    }
    if (code === "ECONNREFUSED") {
      throw new LlmError(
        `Connection refused by ${new URL(url).host} — if this is a local model, ` +
          `make sure it's running (e.g. \`ollama serve\`); otherwise check base_url in ~/.infer.toml.`,
      );
    }
    throw new LlmError(
      `Could not reach ${url}: ${(err as Error).message}. Check your network or provider in ~/.infer.toml.`,
    );
  }
  const elapsed = Date.now() - started;

  if (opts.verbose) log(`[infer] HTTP ${res.status} in ${elapsed}ms`);

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    if (res.status === 401 || res.status === 403) {
      throw new LlmError(
        `${cfg.provider} rejected the API key (HTTP ${res.status}). Check api_key ` +
          `in ~/.infer.toml (or the INFER_API_KEY environment variable).`,
        res.status,
      );
    }
    if (res.status === 404) {
      throw new LlmError(
        `Nothing found at ${url} (HTTP 404). The model "${cfg.model}" or the ` +
          `base_url is probably wrong — check ~/.infer.toml (or run \`infer config --reset\`).`,
        404,
      );
    }
    if (res.status === 429) {
      throw new LlmError(
        `Rate limited by ${cfg.provider} (HTTP 429) — the free tier allows a ` +
          `limited number of requests per minute. Wait a moment or switch providers in ~/.infer.toml.`,
        429,
      );
    }
    throw new LlmError(
      `${cfg.provider} returned HTTP ${res.status}: ${text.slice(0, 200)}`,
      res.status,
    );
  }

  const json = (await res.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  const content = json.choices?.[0]?.message?.content ?? "";
  if (opts.verbose) log(`[infer] reply: ${content.slice(0, 500)}`);
  return content;
}

export async function requestFix(
  cfg: ProviderConfig,
  capture: CaptureRecord,
  opts: LlmCallOptions = {},
): Promise<LlmFixResult> {
  const text = await chat(cfg, buildFixMessages(capture), opts);
  const parsed = parseJsonReply<LlmFixResult>(text);
  if (!parsed) return { fix: null, confident: false, reason: "Could not parse model reply." };
  return {
    fix: typeof parsed.fix === "string" && parsed.fix.trim() ? parsed.fix.trim() : null,
    confident: Boolean(parsed.confident),
    reason: typeof parsed.reason === "string" ? parsed.reason : "",
  };
}

export async function requestDetail(
  cfg: ProviderConfig,
  capture: CaptureRecord,
  opts: LlmCallOptions = {},
): Promise<LlmDetailResult> {
  const text = await chat(cfg, buildDetailMessages(capture), opts);
  const parsed = parseJsonReply<LlmDetailResult>(text);
  return {
    why: parsed?.why ?? "Unable to determine the cause.",
    alternatives: Array.isArray(parsed?.alternatives) ? parsed!.alternatives : [],
    intentQuestion:
      parsed?.intentQuestion ?? "What were you trying to accomplish with this command?",
  };
}

export async function requestRefine(
  cfg: ProviderConfig,
  capture: CaptureRecord,
  question: string,
  answer: string,
  opts: LlmCallOptions = {},
): Promise<string | null> {
  const text = await chat(cfg, buildRefineMessages(capture, question, answer), opts);
  const parsed = parseJsonReply<{ fix?: string }>(text);
  return parsed?.fix && parsed.fix.trim() ? parsed.fix.trim() : null;
}
