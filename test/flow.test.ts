import { describe, expect, it } from "vitest";
import { type FlowDeps, type FlowIO, runInfer } from "../src/flow.js";
import type { CaptureRecord, InferConfig } from "../src/types.js";

const capture: CaptureRecord = {
  command: "npm run buil",
  exitCode: 1,
  cwd: "/proj",
  output: "missing script: buil",
  source: "integration",
  safe: true,
};

const config: InferConfig = {
  llm: {
    provider: "test",
    // Local provider so the core-flow tests skip the network consent gate;
    // the gate itself is covered by its own describe block below.
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

function makeIO(answers: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const ran: string[] = [];
  const asked: string[] = [];
  let i = 0;
  const io: FlowIO = {
    out: (s) => out.push(s),
    err: (s) => err.push(s),
    prompt: async (q) => {
      asked.push(q);
      return answers[i++] ?? "";
    },
    promptEdit: async (v) => answers[i++] ?? v,
    run: async (cmd) => {
      ran.push(cmd);
      return 0;
    },
  };
  return { io, out, err, ran, asked };
}

const fakeLlm = (over: Partial<FlowDeps["llm"]> = {}): FlowDeps["llm"] => ({
  requestFix: async () => ({ fix: "npm run build", confident: true, reason: "typo" }),
  requestDetail: async () => ({
    why: "no such script",
    alternatives: ["npm run dev", "npm test"],
    intentQuestion: "What did you want to build?",
  }),
  requestRefine: async () => "npm run build",
  ...over,
});

function deps(
  answers: string[],
  over: Partial<FlowDeps> = {},
): FlowDeps & { _io: ReturnType<typeof makeIO> } {
  const _io = makeIO(answers);
  return {
    loadConfig: () => config,
    readCapture: () => capture,
    io: _io.io,
    wrapped: true,
    interactive: true,
    llm: fakeLlm(),
    _io,
    ...over,
  };
}

describe("runInfer — tl;dr flow", () => {
  it("prints the fix and emits it on stdout when Enter is pressed (wrapped)", async () => {
    const d = deps([""]); // Enter
    await runInfer({ detail: false, verbose: false }, d);
    expect(d._io.out.join("")).toContain("npm run build");
  });

  it("emits nothing when the user quits", async () => {
    const d = deps(["q"]);
    await runInfer({ detail: false, verbose: false }, d);
    expect(d._io.out.join("")).toBe("");
  });

  it("emits the edited command when the user edits", async () => {
    const d = deps(["e", "npm run build --silent"]);
    await runInfer({ detail: false, verbose: false }, d);
    expect(d._io.out.join("")).toContain("npm run build --silent");
  });

  it("runs via io.run when not wrapped", async () => {
    const d = deps([""], { wrapped: false });
    await runInfer({ detail: false, verbose: false }, d);
    expect(d._io.ran).toEqual(["npm run build"]);
    expect(d._io.out.join("")).toBe("");
  });

  it("prints but never runs when non-interactive (piped/CI)", async () => {
    const d = deps([], { interactive: false, wrapped: false });
    await runInfer({ detail: false, verbose: false }, d);
    expect(d._io.ran).toEqual([]); // never executed
    expect(d._io.out.join("")).toContain("npm run build"); // still printed
  });
});

describe("runInfer — fallthrough to detail", () => {
  it("runs the detail flow when no confident fix is found", async () => {
    const d = deps(["a window build", ""], {
      llm: fakeLlm({
        requestFix: async () => ({ fix: null, confident: false, reason: "unsure" }),
      }),
    });
    await runInfer({ detail: false, verbose: false }, d);
    const err = d._io.err.join("\n");
    expect(err).toContain("Why it failed");
    expect(err).toContain("What did you want to build?");
    expect(d._io.out.join("")).toContain("npm run build"); // refined fix emitted
  });
});

describe("runInfer — explicit --detail", () => {
  it("explains, asks intent, then refines from the answer", async () => {
    const d = deps(["just build the project", ""]);
    await runInfer({ detail: true, verbose: false }, d);
    const err = d._io.err.join("\n");
    expect(err).toContain("Other options");
    expect(err).toContain("npm run dev");
    expect(d._io.out.join("")).toContain("npm run build");
  });

  it("stops cleanly when the user gives no intent answer", async () => {
    const d = deps([""]); // empty answer to the intent question
    await runInfer({ detail: true, verbose: false }, d);
    expect(d._io.err.join("\n")).toContain("nothing to refine");
    expect(d._io.out.join("")).toBe("");
  });
});

describe("runInfer — send gate", () => {
  const remote = (over: Partial<InferConfig["llm"]> = {}) => ({
    ...config,
    llm: { ...config.llm, baseUrl: "https://api.llm7.io/v1", ...over },
  });

  it("asks for consent before sending to a remote provider", async () => {
    let sent = false;
    const d = deps(["y", ""], {
      loadConfig: () => remote(),
      llm: fakeLlm({
        requestFix: async () => {
          sent = true;
          return { fix: "npm run build", confident: true, reason: "typo" };
        },
      }),
    });
    await runInfer({ detail: false, verbose: false }, d);
    const err = d._io.err.join("\n");
    expect(err).toContain("will be sent to api.llm7.io");
    expect(d._io.asked.join("\n")).toContain("Send this to api.llm7.io? [y/N]");
    expect(sent).toBe(true);
  });

  it("does NOT send when the user declines consent", async () => {
    let sent = false;
    const d = deps(["n"], {
      loadConfig: () => remote(),
      llm: fakeLlm({
        requestFix: async () => {
          sent = true;
          return { fix: "x", confident: true, reason: "" };
        },
      }),
    });
    await runInfer({ detail: false, verbose: false }, d);
    expect(sent).toBe(false);
    expect(d._io.err.join("\n")).toContain("Not sent");
  });

  it("refuses to send to a remote provider when non-interactive", async () => {
    let sent = false;
    const d = deps([], {
      interactive: false,
      loadConfig: () => remote(),
      llm: fakeLlm({
        requestFix: async () => {
          sent = true;
          return { fix: "x", confident: true, reason: "" };
        },
      }),
    });
    await runInfer({ detail: false, verbose: false }, d);
    expect(sent).toBe(false);
    expect(d._io.err.join("\n")).toContain("Refusing to send");
  });

  it("refuses to send when redaction is not verified safe", async () => {
    let sent = false;
    const d = deps([], {
      readCapture: () => ({ ...capture, safe: false }),
      llm: fakeLlm({
        requestFix: async () => {
          sent = true;
          return { fix: "x", confident: true, reason: "" };
        },
      }),
    });
    await runInfer({ detail: false, verbose: false }, d);
    expect(sent).toBe(false);
    expect(d._io.err.join("\n")).toContain("Refusing to send");
  });

  it("skips consent for a local provider", async () => {
    const d = deps([""]); // local config, just Enter to run
    await runInfer({ detail: false, verbose: false }, d);
    expect(d._io.err.join("\n")).not.toContain("Send this to");
    expect(d._io.out.join("")).toContain("npm run build");
  });

  it("refuses a remote send when redaction is disabled and not explicitly flagged", async () => {
    let sent = false;
    const d = deps(["y"], {
      loadConfig: () => ({
        ...remote(),
        privacy: { redact: false },
      }),
      llm: fakeLlm({
        requestFix: async () => {
          sent = true;
          return { fix: "x", confident: true, reason: "" };
        },
      }),
    });
    await runInfer({ detail: false, verbose: false }, d);
    expect(sent).toBe(false);
    expect(d._io.err.join("\n")).toContain("--unsafe-no-redact");
  });

  it("warns loudly but proceeds when --unsafe-no-redact is set", async () => {
    const d = deps(["y", ""], {
      loadConfig: () => ({ ...remote(), privacy: { redact: false } }),
    });
    await runInfer({ detail: false, verbose: false, unsafeNoRedact: true }, d);
    expect(d._io.err.join("\n")).toContain("REDACTION DISABLED");
    expect(d._io.out.join("")).toContain("npm run build");
  });
});

describe("runInfer — no capture", () => {
  it("prints an install hint and never calls the llm", async () => {
    let called = false;
    const d = deps([""], {
      readCapture: () => null,
      llm: fakeLlm({
        requestFix: async () => {
          called = true;
          return { fix: null, confident: false, reason: "" };
        },
      }),
    });
    await runInfer({ detail: false, verbose: false }, d);
    expect(d._io.err.join("\n")).toContain("infer setup");
    expect(called).toBe(false);
  });

  it("skips when the last command succeeded (exit 0)", async () => {
    const d = deps([""], {
      readCapture: () => ({ ...capture, exitCode: 0 }),
    });
    await runInfer({ detail: false, verbose: false }, d);
    expect(d._io.err.join("\n")).toContain("exited 0");
    expect(d._io.out.join("")).toBe("");
  });
});
