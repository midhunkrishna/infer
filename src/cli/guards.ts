/**
 * Hard environment guards — fail with clear words instead of stack traces.
 *
 * Called once at process start, before any command runs. Each unmet
 * requirement prints actionable guidance and exits non-zero.
 */
export function enforceEnvironment(): void {
  const nodeMajor = Number(process.versions.node.split(".")[0]);
  if (Number.isFinite(nodeMajor) && nodeMajor < 18) {
    process.stderr.write(
      `infer: Node ${process.versions.node} is too old — version 18 or newer is required.\n` +
        `Upgrade Node (https://nodejs.org) and reinstall: npm i -g infer-cmd\n`,
    );
    process.exit(1);
  }
  if (process.platform === "win32") {
    process.stderr.write(
      "infer: native Windows isn't supported — the shell integration needs zsh/bash/fish.\n" +
        "It works great under WSL: https://learn.microsoft.com/windows/wsl/install\n",
    );
    process.exit(1);
  }
}
