import { describe, expect, it, vi } from "vitest";
import {
  chat,
  LlmError,
  parseJsonReply,
  requestFix,
} from "../src/llm.js";
import type { CaptureRecord, ProviderConfig } from "../src/types.js";

const cfg: ProviderConfig = {
  provider: "test",
  baseUrl: "https://api.example/v1",
  model: "m",
  apiKey: "",
  temperature: 0.2,
  maxTokens: 256,
};

const capture: CaptureRecord = {
  command: "npm run buil",
  exitCode: 1,
  cwd: "/proj",
  output: "missing script: buil",
  source: "integration",
  safe: true,
};

function mockFetch(content: string, ok = true, status = 200): typeof fetch {
  return vi.fn(async () => ({
    ok,
    status,
    json: async () => ({ choices: [{ message: { content } }] }),
    text: async () => content,
  })) as unknown as typeof fetch;
}

describe("parseJsonReply", () => {
  it("parses a clean JSON object", () => {
    expect(parseJsonReply<{ a: number }>(`{"a":1}`)).toEqual({ a: 1 });
  });

  it("parses JSON wrapped in markdown fences", () => {
    expect(parseJsonReply(`\`\`\`json\n{"a":2}\n\`\`\``)).toEqual({ a: 2 });
  });

  it("parses JSON surrounded by prose", () => {
    expect(parseJsonReply(`Sure!\n{"a":3}\nHope that helps`)).toEqual({ a: 3 });
  });

  it("returns null on garbage", () => {
    expect(parseJsonReply("not json at all")).toBeNull();
    expect(parseJsonReply("")).toBeNull();
  });
});

describe("chat", () => {
  it("builds the request body and returns content", async () => {
    const fetchImpl = mockFetch("hello");
    const out = await chat(cfg, [{ role: "user", content: "hi" }], { fetchImpl });
    expect(out).toBe("hello");
    const call = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(call[0]).toBe("https://api.example/v1/chat/completions");
    expect(JSON.parse(call[1].body).model).toBe("m");
  });

  it("prints the redacted payload when verbose", async () => {
    const logs: string[] = [];
    await chat(cfg, [{ role: "user", content: "ctx" }], {
      fetchImpl: mockFetch("ok"),
      verbose: true,
      log: (m) => logs.push(m),
    });
    const joined = logs.join("\n");
    expect(joined).toContain("payload");
    expect(joined).toContain("HTTP 200");
    expect(joined).toContain('"content": "ctx"');
  });

  it("throws a friendly LlmError on HTTP 429", async () => {
    await expect(
      chat(cfg, [], { fetchImpl: mockFetch("rate", false, 429) }),
    ).rejects.toBeInstanceOf(LlmError);
  });

  it("throws LlmError when the network is unreachable", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    await expect(chat(cfg, [], { fetchImpl })).rejects.toThrow(/Could not reach/);
  });
});

describe("requestFix", () => {
  it("returns a parsed, trimmed fix", async () => {
    const fetchImpl = mockFetch(`{"fix":"npm run build ","confident":true,"reason":"typo"}`);
    const r = await requestFix(cfg, capture, { fetchImpl });
    expect(r).toEqual({ fix: "npm run build", confident: true, reason: "typo" });
  });

  it("degrades gracefully when the reply is unparseable", async () => {
    const r = await requestFix(cfg, capture, { fetchImpl: mockFetch("???") });
    expect(r.fix).toBeNull();
    expect(r.confident).toBe(false);
  });

  it("treats an empty fix as no fix", async () => {
    const r = await requestFix(cfg, capture, {
      fetchImpl: mockFetch(`{"fix":"","confident":true,"reason":"x"}`),
    });
    expect(r.fix).toBeNull();
  });
});
