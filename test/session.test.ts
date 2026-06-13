import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  lastSegment,
  readCapture,
  SEGMENT_MARKER,
  sessionDir,
} from "../src/capture/session.js";

describe("sessionDir", () => {
  it("uses XDG_STATE_HOME when set", () => {
    expect(sessionDir(42, { XDG_STATE_HOME: "/xdg" })).toBe("/xdg/infer/42");
  });

  it("falls back to ~/.local/state", () => {
    const d = sessionDir(7, { HOME: "/home/u" } as NodeJS.ProcessEnv);
    expect(d.endsWith("/infer/7")).toBe(true);
  });
});

describe("lastSegment", () => {
  it("returns the content after the last marker", () => {
    const raw = `${SEGMENT_MARKER}old output${SEGMENT_MARKER}new output`;
    expect(lastSegment(raw)).toBe("new output");
  });

  it("returns the whole string when no marker present", () => {
    expect(lastSegment("just output")).toBe("just output");
  });

  it("strips a single leading newline", () => {
    expect(lastSegment(`${SEGMENT_MARKER}\nhello`)).toBe("hello");
  });
});

describe("readCapture", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "infer-sess-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("returns null when nothing is captured", () => {
    expect(readCapture({ dir, env: {} })).toBeNull();
  });

  it("reads command, exit code, cwd and last output segment", () => {
    writeFileSync(join(dir, "cmd"), "npm run buil\n");
    writeFileSync(join(dir, "exit"), "1\n");
    writeFileSync(join(dir, "meta"), "cwd=/proj\nshell=zsh\n");
    writeFileSync(
      join(dir, "out"),
      `${SEGMENT_MARKER}stale${SEGMENT_MARKER}missing script: buil`,
    );

    const cap = readCapture({ dir, env: {} });
    expect(cap).not.toBeNull();
    expect(cap!.command).toBe("npm run buil");
    expect(cap!.exitCode).toBe(1);
    expect(cap!.cwd).toBe("/proj");
    expect(cap!.output).toBe("missing script: buil");
    expect(cap!.source).toBe("integration");
  });

  it("redacts secrets in captured output", () => {
    writeFileSync(join(dir, "cmd"), "deploy\n");
    writeFileSync(join(dir, "exit"), "1\n");
    writeFileSync(join(dir, "out"), `${SEGMENT_MARKER}AWS_SECRET=topsecret`);
    const cap = readCapture({ dir, env: {} });
    expect(cap!.output).toContain("‹REDACTED›");
    expect(cap!.output).not.toContain("topsecret");
  });

  it("redacts secrets embedded in the command line itself", () => {
    writeFileSync(join(dir, "cmd"), 'curl -H "Authorization: Bearer sk-abc123" api\n');
    writeFileSync(join(dir, "exit"), "1\n");
    writeFileSync(join(dir, "out"), `${SEGMENT_MARKER}401 Unauthorized`);
    const cap = readCapture({ dir, env: {} });
    expect(cap!.command).not.toContain("sk-abc123");
    expect(cap!.command).toContain("‹REDACTED›");
  });

  it("does not redact the command when redaction is disabled", () => {
    writeFileSync(join(dir, "cmd"), "export API_KEY=plain\n");
    writeFileSync(join(dir, "exit"), "1\n");
    writeFileSync(join(dir, "out"), `${SEGMENT_MARKER}err`);
    const cap = readCapture({ dir, env: {}, redact: false });
    expect(cap!.command).toContain("plain");
  });
});
