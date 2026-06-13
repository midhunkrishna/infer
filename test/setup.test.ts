import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applySetup, planSetup, rcFileFor } from "../src/shell/setup.js";

describe("rcFileFor", () => {
  it("zsh honors ZDOTDIR", () => {
    expect(rcFileFor("zsh", { ZDOTDIR: "/zd" }, "/home/u")).toBe("/zd/.zshrc");
    expect(rcFileFor("zsh", {}, "/home/u")).toBe("/home/u/.zshrc");
  });
  it("bash uses .bash_profile on macOS, .bashrc elsewhere", () => {
    expect(rcFileFor("bash", {}, "/home/u", "darwin")).toBe("/home/u/.bash_profile");
    expect(rcFileFor("bash", {}, "/home/u", "linux")).toBe("/home/u/.bashrc");
  });
  it("fish honors XDG_CONFIG_HOME", () => {
    expect(rcFileFor("fish", { XDG_CONFIG_HOME: "/xc" }, "/h")).toBe(
      "/xc/fish/config.fish",
    );
    expect(rcFileFor("fish", {}, "/h")).toBe("/h/.config/fish/config.fish");
  });
});

describe("planSetup / applySetup", () => {
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "infer-setup-"));
  });
  afterEach(() => rmSync(home, { recursive: true, force: true }));

  it("plans a guarded line and applies it (creating the rc file)", () => {
    const plan = planSetup({ SHELL: "/bin/zsh" }, home, "darwin");
    expect(plan.shell).toBe("zsh");
    expect(plan.line).toContain("command -v infer >/dev/null");
    expect(plan.alreadyInstalled).toBe(false);

    applySetup(plan);
    const content = readFileSync(plan.rcFile, "utf8");
    expect(content).toContain('eval "$(infer init zsh)"');

    // Idempotence: a second plan sees it as installed.
    expect(planSetup({ SHELL: "/bin/zsh" }, home, "darwin").alreadyInstalled).toBe(true);
  });

  it("creates parent dirs for fish config", () => {
    const plan = planSetup({ SHELL: "/usr/bin/fish" }, home, "linux");
    applySetup(plan);
    expect(readFileSync(plan.rcFile, "utf8")).toContain("infer init fish | source");
  });

  it("appends a missing trailing newline before its own block", () => {
    const rc = join(home, ".zshrc");
    writeFileSync(rc, "export FOO=1"); // no trailing newline
    const plan = planSetup({ SHELL: "/bin/zsh" }, home, "linux");
    applySetup(plan);
    const content = readFileSync(rc, "utf8");
    expect(content).toContain("export FOO=1\n");
    expect(content).toContain('eval "$(infer init zsh)"');
  });
});
