import { describe, expect, it } from "vitest";
import {
  containsLikelySecret,
  maskHighEntropy,
  redactSecrets,
  safeSanitize,
  sanitize,
  sanitizeCwd,
  shannonEntropy,
} from "../src/redact.js";

/**
 * Known-secret corpus. Each entry is a realistic line a failing command might
 * print or that a user might type. `secret` is the sensitive substring that
 * must NEVER survive redaction.
 */
const CORPUS: Array<{ name: string; text: string; secret: string }> = [
  { name: "OpenAI sk-proj", text: "Error: invalid key sk-proj-aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789abcd", secret: "sk-proj-aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789abcd" },
  { name: "OpenAI sk-", text: "using sk-aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789", secret: "sk-aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789" },
  { name: "Anthropic sk-ant", text: "ANTHROPIC=sk-ant-api03-aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789ab", secret: "sk-ant-api03-aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789ab" },
  { name: "GitHub ghp_", text: "remote: token ghp_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789", secret: "ghp_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789" },
  { name: "GitHub PAT", text: "github_pat_11ABCDEFG0aBcDeFgHiJkLmNoPqRsT", secret: "github_pat_11ABCDEFG0aBcDeFgHiJkLmNoPqRsT" },
  { name: "GitLab glpat", text: "glpat-aBcDeFgHiJkLmNoPqRsTu", secret: "glpat-aBcDeFgHiJkLmNoPqRsTu" },
  { name: "Slack xoxb", text: "SLACK=xoxb-123456789012-abcdefghijklmnop", secret: "xoxb-123456789012-abcdefghijklmnop" },
  { name: "Google AIza", text: "key AIzaSyA1234567890aBcDeFgHiJkLmNoPqRsTuV", secret: "AIzaSyA1234567890aBcDeFgHiJkLmNoPqRsTuV" },
  { name: "Stripe live", text: "sk_live_aBcDeFgHiJkLmNoPqRsTuVwX", secret: "sk_live_aBcDeFgHiJkLmNoPqRsTuVwX" },
  { name: "HuggingFace", text: "hf_aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789", secret: "hf_aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789" },
  { name: "npm token", text: "//registry.npmjs.org/:_authToken=npm_aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456", secret: "npm_aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456" },
  { name: "AWS key id", text: "aws: AKIAIOSFODNN7EXAMPLE denied", secret: "AKIAIOSFODNN7EXAMPLE" },
  { name: "JWT", text: "token=eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N", secret: "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N" },
  { name: "Bearer header", text: "curl -H 'Authorization: Bearer sk-secretBearerToken123456789' api", secret: "sk-secretBearerToken123456789" },
  { name: "postgres conn", text: "psql postgres://admin:s3cr3tP4ssw0rd@db.host:5432/app", secret: "s3cr3tP4ssw0rd" },
  { name: "query password", text: "GET https://api/x?user=a&password=hunter2secretval&z=1", secret: "hunter2secretval" },
  { name: "JSON apiKey", text: '{"apiKey":"abc123SECRETvalue456xyz","ok":true}', secret: "abc123SECRETvalue456xyz" },
  { name: "env assignment", text: "export STRIPE_SECRET_KEY=rk_live_zzzSensitiveValue999", secret: "rk_live_zzzSensitiveValue999" },
  { name: "flag --token space", text: "deploy --token gho_spaceDelimitedTokenValue12345 --yes", secret: "gho_spaceDelimitedTokenValue12345" },
  { name: "flag --password=", text: "app --password=myPlaintextPass123 run", secret: "myPlaintextPass123" },
  { name: "mysql -p glued", text: "mysql -pSuperSecretDbPass99 -u root", secret: "SuperSecretDbPass99" },
];

describe("known-secret corpus — zero raw leakage", () => {
  for (const { name, text, secret } of CORPUS) {
    it(`redacts: ${name}`, () => {
      const out = redactSecrets(text);
      expect(out, `raw secret survived for ${name}`).not.toContain(secret);
      expect(out).toContain("‹");
    });

    it(`safeSanitize verifies clean: ${name}`, () => {
      const r = safeSanitize(text);
      expect(r.ok).toBe(true);
      expect(r.text).not.toContain(secret);
      expect(containsLikelySecret(r.text)).toBe(false);
    });
  }
});

describe("entropy catch-all", () => {
  it("masks an unstructured high-entropy token with no known prefix", () => {
    const tok = "Xk9fQ2mPv7Lz3Wn8Bt4Rd6Yc1Hs5Jg0Aa";
    expect(maskHighEntropy(`value ${tok} end`)).toContain("‹HIGH_ENTROPY›");
    expect(maskHighEntropy(`value ${tok} end`)).not.toContain(tok);
  });

  it("masks long hex (sha-like) secrets", () => {
    const hex = "a".repeat(20) + "f3c9b1d2e4a5b6c7d8e9f0a1";
    expect(maskHighEntropy(hex)).toContain("‹HIGH_ENTROPY›");
  });

  it("leaves ordinary prose and paths alone", () => {
    const prose = "the quick brown fox jumps over the lazy dog";
    expect(maskHighEntropy(prose)).toBe(prose);
    const path = "/usr/local/lib/node_modules/some-package/index.js";
    expect(maskHighEntropy(path)).toBe(path);
  });

  it("shannonEntropy ranks random tokens above english", () => {
    expect(shannonEntropy("Xk9fQ2mPv7Lz3Wn8Bt4")).toBeGreaterThan(
      shannonEntropy("aaaaaaaaaaaaaaaaaaaa"),
    );
  });
});

describe("containsLikelySecret verifier", () => {
  it("flags raw secrets and clears redacted text", () => {
    const raw = "ghp_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789";
    expect(containsLikelySecret(raw)).toBe(true);
    expect(containsLikelySecret(redactSecrets(raw))).toBe(false);
  });
});

describe("fail-closed sanitize", () => {
  it("returns ok=true for clean/redactable input", () => {
    expect(safeSanitize("npm run buil").ok).toBe(true);
  });

  it("bypasses verification when redaction is explicitly disabled", () => {
    const r = safeSanitize("ghp_rawtokenvalue000000000000000000000", { redact: false });
    expect(r.ok).toBe(true); // user opted out; not our gate to block here
  });
});

describe("ReDoS / pathological input is bounded", () => {
  it("handles an unterminated PEM header fast", () => {
    const input = "-----BEGIN RSA PRIVATE KEY-----" + "A".repeat(60_000);
    const t0 = Date.now();
    const out = sanitize(input);
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(out).toContain("‹PRIVATE_KEY›");
  });

  it("handles a giant Authorization value fast", () => {
    const input = "Authorization: " + "x".repeat(60_000);
    const t0 = Date.now();
    sanitize(input);
    expect(Date.now() - t0).toBeLessThan(2000);
  });
});

describe("boundary safety", () => {
  it("elides a secret buried in the middle of huge output", () => {
    const big =
      "head\n" + "A".repeat(50_000) + " AKIAIOSFODNN7EXAMPLE " + "B".repeat(50_000) + "\ntail";
    const out = sanitize(big, { maxBytes: 4096 });
    expect(out).not.toContain("AKIAIOSFODNN7EXAMPLE");
    expect(out).toContain("bytes elided");
  });
});

describe("sanitizeCwd", () => {
  it("collapses $HOME to ~ and redacts secrets in path", () => {
    const out = sanitizeCwd("/home/bob/work", { home: "/home/bob" });
    expect(out).toBe("~/work");
  });

  it("redacts a token accidentally living in a path", () => {
    const out = sanitizeCwd("/tmp/ghp_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789/x", {
      home: "/home/bob",
    });
    expect(out).not.toContain("ghp_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789");
  });
});
