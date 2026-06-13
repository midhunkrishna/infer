import { homedir } from "node:os";
import stripAnsi from "strip-ansi";

/**
 * Redaction is a DENYLIST and therefore best-effort by nature: new secret
 * formats always outrun named patterns. We compensate with (a) a broad set of
 * known patterns, (b) a generic high-entropy catch-all, and (c) fail-closed
 * behaviour at the call sites (see `safeSanitize` / the send gate in flow.ts).
 *
 * Over-redaction is the intended failure direction.
 */

/** Named patterns, applied in order. Each is linear-time (no nested quantifiers). */
const SECRET_PATTERNS: Array<[RegExp, string]> = [
  // --- Private key material -------------------------------------------------
  [
    /-----BEGIN[A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END[A-Z0-9 ]*PRIVATE KEY-----/g,
    "‹PRIVATE_KEY›",
  ],
  // Unterminated PEM header (still sensitive, and avoids scanning to EOF).
  [/-----BEGIN[A-Z0-9 ]*PRIVATE KEY-----/g, "‹PRIVATE_KEY›"],

  // --- Provider-specific key formats (match even when bare) -----------------
  [/\bsk-ant-[A-Za-z0-9_-]{20,}/g, "‹ANTHROPIC_KEY›"],
  [/\bsk-proj-[A-Za-z0-9_-]{20,}/g, "‹OPENAI_KEY›"],
  [/\bsk-[A-Za-z0-9]{20,}/g, "‹OPENAI_KEY›"],
  [/\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{30,}/g, "‹GITHUB_TOKEN›"],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}/g, "‹GITHUB_TOKEN›"],
  [/\bglpat-[A-Za-z0-9_-]{18,}/g, "‹GITLAB_TOKEN›"],
  [/\bxox[baprs]-[A-Za-z0-9-]{10,}/g, "‹SLACK_TOKEN›"],
  [/\bAIza[A-Za-z0-9_-]{35}/g, "‹GOOGLE_KEY›"],
  [/\b(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{16,}/g, "‹STRIPE_KEY›"],
  [/\bSG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}/g, "‹SENDGRID_KEY›"],
  [/\bhf_[A-Za-z0-9]{30,}/g, "‹HF_TOKEN›"],
  [/\bnpm_[A-Za-z0-9]{36}/g, "‹NPM_TOKEN›"],
  [/\bdop_v1_[A-Za-z0-9]{60,}/g, "‹DIGITALOCEAN_TOKEN›"],
  [/\b(?:AKIA|ASIA|AGPA|AIDA|AROA|ANPA|ABIA|ACCA)[A-Z0-9]{16}\b/g, "‹AWS_KEY›"],

  // --- Headers & schemes ----------------------------------------------------
  // Authorization header: redact the WHOLE value (scheme + credential).
  [/\b(Authorization\s*[:=]\s*)["']?([^"'\n\r]+)/gi, "$1‹REDACTED›"],
  [/\bBearer\s+[A-Za-z0-9._~+/-]+=*/g, "Bearer ‹REDACTED›"],
  [/\b(?:Basic|Token|ApiKey|Api-Key)\s+[A-Za-z0-9._~+/=-]{8,}/g, "‹REDACTED›"],

  // --- JWTs -----------------------------------------------------------------
  [/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, "‹JWT›"],

  // --- key/secret/token/password in JSON ("key": "value") -------------------
  [
    /("(?:[A-Za-z0-9 _-]*(?:key|secret|token|password|passwd|pwd|auth)[A-Za-z0-9 _-]*)"\s*:\s*")([^"\n‹›]+)(")/gi,
    "$1‹REDACTED›$3",
  ],
  // key/secret/token/password assignments: env / YAML, with `=` or `:` only.
  // (A bare space separator would wreck prose like "token expired".)
  [
    /\b([A-Za-z0-9_.-]*(?:key|secret|token|password|passwd|pwd)[A-Za-z0-9_.-]*\s*[:=]\s*)(['"]?)([^\s'"‹›]+)\2/gi,
    "$1$2‹REDACTED›$2",
  ],
  // CLI flags taking a credential: --token X, --password=X, --api-key X.
  [
    /(--?(?:token|password|passwd|pwd|secret|api[_-]?key|auth|access[_-]?token)[=\s]+)(['"]?)([^\s'"‹›]+)\2/gi,
    "$1$2‹REDACTED›$2",
  ],
  // mysql-style `-psecret` (password glued to the flag).
  [/(\s-p)([^\s'"‹›]{4,})/g, "$1‹REDACTED›"],

  // --- Credentials inside URLs / connection strings -------------------------
  // user:pass@host
  [/\b([a-z][a-z0-9+.-]*:\/\/)([^/\s:@]+):([^/\s:@]+)@/gi, "$1$2:‹REDACTED›@"],
  // ...?password=... / &token=... query params
  [/([?&](?:password|passwd|pwd|token|secret|api[_-]?key|auth)=)([^&\s'"‹›]+)/gi, "$1‹REDACTED›"],
];

/** Strip ANSI escape sequences. */
export function stripAnsiCodes(input: string): string {
  return stripAnsi(input);
}

/** Shannon entropy (bits per character) of a string. */
export function shannonEntropy(s: string): number {
  if (!s) return 0;
  const counts = new Map<string, number>();
  for (const ch of s) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  let h = 0;
  for (const c of counts.values()) {
    const p = c / s.length;
    h -= p * Math.log2(p);
  }
  return h;
}

/**
 * Generic catch-all: mask any long, high-entropy token that looks like a
 * credential, regardless of known prefix. Tuned to avoid masking ordinary
 * prose/paths (those are space- or slash-delimited and lower entropy).
 */
export function maskHighEntropy(input: string): string {
  return input.replace(/[A-Za-z0-9+/=_-]{20,}/g, (tok) => {
    // Long hex (e.g. 40-char SHA-like / hex secrets).
    if (tok.length >= 32 && /^[0-9a-fA-F]+$/.test(tok)) return "‹HIGH_ENTROPY›";
    // Mixed alnum with high entropy = very likely a key/token, not a word.
    const mixed = /[a-z]/.test(tok) && /[A-Z0-9]/.test(tok);
    const hasDigit = /[0-9]/.test(tok);
    if ((mixed || hasDigit) && shannonEntropy(tok) >= 3.5) return "‹HIGH_ENTROPY›";
    return tok;
  });
}

/** Replace recognized secrets, then run the entropy catch-all. */
export function redactSecrets(input: string): string {
  let out = input;
  for (const [re, replacement] of SECRET_PATTERNS) out = out.replace(re, replacement);
  return maskHighEntropy(out);
}

/**
 * Verifier used for fail-closed checks: does text still look like it contains a
 * raw secret after redaction? (Should always be false post-redaction.)
 */
export function containsLikelySecret(text: string): boolean {
  if (/-----BEGIN[A-Z0-9 ]*PRIVATE KEY/.test(text)) return true;
  if (/\b(sk-|sk-ant-|ghp_|gho_|github_pat_|glpat-|xox[baprs]-|AIza|hf_|npm_)/.test(text))
    return true;
  for (const m of text.matchAll(/[A-Za-z0-9+/=_-]{20,}/g)) {
    const tok = m[0];
    if (tok.includes("‹")) continue;
    if (tok.length >= 32 && /^[0-9a-fA-F]+$/.test(tok)) return true;
    if (/[0-9]/.test(tok) && shannonEntropy(tok) >= 3.5) return true;
  }
  return false;
}

/**
 * Cap a long string by keeping head + tail and eliding the middle. Bounds the
 * input size BEFORE redaction so pathological inputs can't blow up runtime.
 */
export function capHeadTail(input: string, maxBytes = 65_536): string {
  const buf = Buffer.from(input, "utf8");
  if (buf.byteLength <= maxBytes) return input;
  const half = Math.floor(maxBytes / 2);
  const head = buf.subarray(0, half).toString("utf8");
  const tail = buf.subarray(buf.byteLength - half).toString("utf8");
  const elided = buf.byteLength - maxBytes;
  return `${head}\n… [${elided} bytes elided] …\n${tail}`;
}

/**
 * Sanitize text for sending to an LLM: strip ANSI, BOUND size, then redact.
 * Capping first keeps redaction linear-time on bounded input (ReDoS guard).
 */
export function sanitize(
  input: string,
  opts: { redact?: boolean; maxBytes?: number } = {},
): string {
  const { redact = true, maxBytes = 65_536 } = opts;
  let out = stripAnsiCodes(input);
  out = capHeadTail(out, maxBytes);
  if (redact) out = redactSecrets(out);
  return out;
}

/** Result of a fail-closed sanitize. `ok=false` means the caller MUST NOT send. */
export interface SafeSanitizeResult {
  text: string;
  ok: boolean;
  reason?: string;
}

/**
 * Fail-closed wrapper. If redaction throws, or still leaves something that
 * looks like a secret, return ok=false so the caller refuses to transmit.
 */
export function safeSanitize(
  input: string,
  opts: { redact?: boolean; maxBytes?: number } = {},
): SafeSanitizeResult {
  if (opts.redact === false) return { text: sanitize(input, opts), ok: true };
  try {
    const text = sanitize(input, opts);
    if (containsLikelySecret(text)) {
      return {
        text,
        ok: false,
        reason: "output still appears to contain a secret after redaction",
      };
    }
    return { text, ok: true };
  } catch (err) {
    return { text: "", ok: false, reason: `redaction failed: ${(err as Error).message}` };
  }
}

/** Sanitize a filesystem path: collapse $HOME to ~ then run redaction over it. */
export function sanitizeCwd(
  cwd: string,
  opts: { redact?: boolean; home?: string } = {},
): string {
  const home = opts.home ?? homedir();
  let out = cwd;
  if (home && out.startsWith(home)) out = `~${out.slice(home.length)}`;
  if (opts.redact !== false) out = redactSecrets(out);
  return out;
}
