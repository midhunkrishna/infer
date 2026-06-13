import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadConfig, loadDenyList, redactedConfig } from "../src/config.js";

describe("loadConfig", () => {
  let dir: string;
  let path: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "infer-cfg-"));
    path = join(dir, ".infer.toml");
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("generates a default config file on first run", () => {
    expect(existsSync(path)).toBe(false);
    const cfg = loadConfig({ INFER_CONFIG: path });
    expect(existsSync(path)).toBe(true);
    expect(cfg.llm.provider).toBe("llm7");
    expect(cfg.llm.baseUrl).toBe("https://api.llm7.io/v1");
    expect(cfg.privacy.redact).toBe(true);
    expect(cfg.capture.maxBytes).toBe(65536);
  });

  it("parses overrides and strips trailing slash on base_url", () => {
    writeFileSync(
      path,
      `[llm]\nprovider="groq"\nbase_url="https://api.groq.com/openai/v1/"\nmodel="llama-3.3-70b-versatile"\napi_key="gsk_filekey"\n`,
    );
    const cfg = loadConfig({ INFER_CONFIG: path });
    expect(cfg.llm.provider).toBe("groq");
    expect(cfg.llm.baseUrl).toBe("https://api.groq.com/openai/v1");
    expect(cfg.llm.apiKey).toBe("gsk_filekey");
  });

  it("lets INFER_API_KEY env override the file api_key", () => {
    writeFileSync(path, `[llm]\napi_key="fromfile"\n`);
    const cfg = loadConfig({ INFER_CONFIG: path, INFER_API_KEY: "fromenv" });
    expect(cfg.llm.apiKey).toBe("fromenv");
  });

  it("throws a clear error on malformed TOML", () => {
    writeFileSync(path, `[llm\nbroken`);
    expect(() => loadConfig({ INFER_CONFIG: path })).toThrow(/Failed to parse/);
  });

  it("rejects a base_url without a scheme, naming the bad value", () => {
    writeFileSync(path, `[llm]\nbase_url="llm7.io/v1"\n`);
    expect(() => loadConfig({ INFER_CONFIG: path })).toThrow(/Invalid base_url "llm7.io\/v1"/);
  });

  it("suggests config --reset on a bad base_url", () => {
    writeFileSync(path, `[llm]\nbase_url="not a url"\n`);
    expect(() => loadConfig({ INFER_CONFIG: path })).toThrow(/config --reset/);
  });

  it("parses the [capture] deny list, dropping unsafe entries", () => {
    writeFileSync(
      path,
      `[capture]\ndeny = ["mytool", "python3.9", "bad name", "evil';rm -rf /", 42]\n`,
    );
    const cfg = loadConfig({ INFER_CONFIG: path });
    // Spaces, shell metacharacters and non-strings are dropped.
    expect(cfg.capture.deny).toEqual(["mytool", "python3.9"]);
  });

  it("defaults deny to an empty list when absent", () => {
    const cfg = loadConfig({ INFER_CONFIG: path });
    expect(cfg.capture.deny).toEqual([]);
  });
});

describe("loadDenyList", () => {
  let dir: string;
  let path: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "infer-deny-"));
    path = join(dir, ".infer.toml");
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("returns sanitized entries from the config", () => {
    writeFileSync(path, `[capture]\ndeny = ["claude-ish", "rm -rf", "ok_tool"]\n`);
    expect(loadDenyList({ INFER_CONFIG: path })).toEqual(["claude-ish", "ok_tool"]);
  });

  it("never throws and never creates the file (safe for shell startup)", () => {
    // Missing file → empty, and the file must NOT be created (unlike loadConfig).
    expect(loadDenyList({ INFER_CONFIG: path })).toEqual([]);
    expect(existsSync(path)).toBe(false);
    // Malformed TOML and an invalid base_url must not throw here.
    writeFileSync(path, `[llm\nbase_url="not a url"`);
    expect(loadDenyList({ INFER_CONFIG: path })).toEqual([]);
  });
});

describe("redactedConfig", () => {
  it("masks the api key", () => {
    const dir = mkdtempSync(join(tmpdir(), "infer-cfg-"));
    const path = join(dir, ".infer.toml");
    writeFileSync(path, `[llm]\napi_key="secret"\n`);
    const cfg = redactedConfig(loadConfig({ INFER_CONFIG: path }));
    expect(cfg.llm.apiKey).toBe("‹set›");
    expect(readFileSync(path, "utf8")).toContain("secret");
    rmSync(dir, { recursive: true, force: true });
  });
});
