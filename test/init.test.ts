import { describe, expect, it } from "vitest";
import { detectShell, initScript } from "../src/shell/init.js";

describe("initScript", () => {
  it("emits zsh hooks, markers, cleanup and the wrapper", () => {
    const s = initScript("zsh");
    expect(s).toContain("add-zsh-hook preexec _infer_preexec");
    expect(s).toContain("add-zsh-hook precmd _infer_precmd");
    expect(s).toContain("add-zsh-hook zshexit _infer_cleanup");
    expect(s).toContain("INFER_WRAPPED=1");
    expect(s).toContain("infer()"); // wrapper function
    expect(s).toContain("$'\\x1e'"); // segment marker
    expect(s).toContain("infer|infer\\ *"); // skip guard for infer itself
    expect(s).toContain("INFER_TTL_MIN"); // at-rest TTL sweep
    expect(s).toContain("-mmin"); // age-based cleanup
  });

  it("emits a bash DEBUG trap and PROMPT_COMMAND hook", () => {
    const s = initScript("bash");
    expect(s).toContain("trap '_infer_preexec' DEBUG");
    expect(s).toContain("_infer_precmd");
    expect(s).toContain("exec 21>&1 22>&2"); // numbered fds for bash 3.2
    expect(s).toContain("INFER_WRAPPED=1");
  });

  it("emits fish preexec/postexec events and wrapper", () => {
    const s = initScript("fish");
    expect(s).toContain("--on-event fish_preexec");
    expect(s).toContain("--on-event fish_postexec");
    expect(s).toContain("function infer");
  });
});

describe("detectShell", () => {
  it("detects fish, bash and defaults to zsh", () => {
    expect(detectShell({ SHELL: "/usr/bin/fish" })).toBe("fish");
    expect(detectShell({ SHELL: "/bin/bash" })).toBe("bash");
    expect(detectShell({ SHELL: "/bin/zsh" })).toBe("zsh");
    expect(detectShell({})).toBe("zsh");
  });
});
