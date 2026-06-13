import { describe, expect, it } from "vitest";
import {
  capHeadTail,
  redactSecrets,
  sanitize,
  stripAnsiCodes,
} from "../src/redact.js";

describe("redactSecrets", () => {
  it("redacts AWS access key ids (even outside an assignment)", () => {
    expect(redactSecrets("using AKIAIOSFODNN7EXAMPLE now")).toContain("‹AWS_KEY›");
    expect(redactSecrets("using AKIAIOSFODNN7EXAMPLE now")).not.toContain("AKIAIOSFODNN7");
  });

  it("redacts Bearer tokens and Authorization headers", () => {
    expect(redactSecrets("Bearer abc.def-123")).toBe("Bearer ‹REDACTED›");
    expect(redactSecrets("Authorization: sometoken")).toContain("‹REDACTED›");
  });

  it("redacts KEY/SECRET/TOKEN/PASSWORD assignments", () => {
    expect(redactSecrets("API_KEY=supersecret")).toBe("API_KEY=‹REDACTED›");
    expect(redactSecrets('DB_PASSWORD="hunter2"')).toBe('DB_PASSWORD="‹REDACTED›"');
    expect(redactSecrets("GITHUB_TOKEN=ghp_xxx")).toContain("‹REDACTED›");
  });

  it("redacts JWTs", () => {
    const jwt = "eyJhbGci.eyJzdWIiOiIxMjM.SflKxwRJSMeKKF2QT4";
    expect(redactSecrets(`token ${jwt}`)).toBe("token ‹JWT›");
  });

  it("redacts PEM private key blocks", () => {
    const pem =
      "-----BEGIN RSA PRIVATE KEY-----\nMIIBVAIBADANBg\n-----END RSA PRIVATE KEY-----";
    expect(redactSecrets(pem)).toBe("‹PRIVATE_KEY›");
  });

  it("redacts credentials embedded in URLs", () => {
    expect(redactSecrets("https://user:p4ss@host/x")).toBe(
      "https://user:‹REDACTED›@host/x",
    );
  });

  it("leaves ordinary text untouched", () => {
    const s = "npm error: missing script 'buil'";
    expect(redactSecrets(s)).toBe(s);
  });
});

describe("stripAnsiCodes", () => {
  it("removes color escape sequences", () => {
    expect(stripAnsiCodes("[31mred[0m")).toBe("red");
  });
});

describe("capHeadTail", () => {
  it("keeps short strings intact", () => {
    expect(capHeadTail("hello", 100)).toBe("hello");
  });

  it("keeps head and tail with an elision marker when too long", () => {
    const input = "A".repeat(1000) + "Z".repeat(1000);
    const out = capHeadTail(input, 200);
    expect(out).toContain("bytes elided");
    expect(out.startsWith("A")).toBe(true);
    expect(out.endsWith("Z")).toBe(true);
    expect(Buffer.byteLength(out, "utf8")).toBeLessThan(400);
  });
});

describe("sanitize", () => {
  it("strips ansi, redacts, then caps", () => {
    const out = sanitize("[31mAPI_KEY=abc[0m", { maxBytes: 100 });
    expect(out).toBe("API_KEY=‹REDACTED›");
  });

  it("can skip redaction when disabled", () => {
    expect(sanitize("API_KEY=abc", { redact: false })).toBe("API_KEY=abc");
  });
});
