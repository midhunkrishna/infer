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

  // After running a chosen fix in-shell, the wrapper must record the fix as the
  // new command AND surface its real exit — so a follow-up `infer` operates on
  // the fix's result, not infer's own (always-0) status. precmd/postexec must
  // not clobber the recorded exit during infer's own invocation.
  it.each(["zsh", "bash", "fish"] as const)(
    "%s: infer is transparent and records the fix's real exit",
    (shell) => {
      const s = initScript(shell);
      expect(s).toContain("INFER_SELF"); // skip-exit-write flag
      // the wrapper captures the eval's status and writes it to the exit file
      expect(s).toMatch(/eval[\s\S]*\$INFER_DIR\/exit/);
    },
  );

  it.each(["zsh", "bash"] as const)(
    "%s: denylists claude and supports INFER_DENY",
    (shell) => {
      const s = initScript(shell);
      expect(s).toContain("claude"); // interactive AI CLI that needs a real TTY
      expect(s).toContain("INFER_DENY"); // user-extensible denylist
    },
  );

  it.each(["zsh", "bash"] as const)(
    "%s: merges config deny entries into the baked denylist, dropping unsafe ones",
    (shell) => {
      const s = initScript(shell, ["mytool", "py.thon", "bad name", "x';y"]);
      expect(s).toContain("_infer_denylist='vim|"); // built-ins preserved
      expect(s).toContain("|mytool|"); // valid entry merged
      expect(s).toContain("py.thon"); // dots are allowed
      expect(s).not.toContain("bad name"); // space → dropped
      expect(s).not.toContain("x';y"); // quote → dropped (no snippet escape)
      expect(s).not.toContain("__INFER_DENYLIST__"); // sentinel fully replaced
    },
  );

  it("ignores extra deny entries for fish (no capture pipe)", () => {
    const s = initScript("fish", ["mytool"]);
    expect(s).not.toContain("mytool");
    expect(s).not.toContain("_infer_denylist");
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
