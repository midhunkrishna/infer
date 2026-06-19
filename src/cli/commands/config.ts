import { copyFileSync, existsSync, writeFileSync } from "node:fs";
import {
  configPath,
  DEFAULT_CONFIG_TOML,
  loadConfig,
  redactedConfig,
} from "../../config.js";
import type { TerminalIO } from "../io.js";

/** `infer config`: print the resolved config, or `--reset` to regenerate it. */
export function runConfig(io: TerminalIO, opts: { reset?: boolean }): void {
  const path = configPath();
  if (opts.reset) {
    if (existsSync(path)) {
      copyFileSync(path, `${path}.bak`);
      io.err(`backed up old config to ${path}.bak`);
    }
    writeFileSync(path, DEFAULT_CONFIG_TOML, { mode: 0o600 });
    io.err(`wrote fresh defaults to ${path}`);
    return;
  }
  const cfg = redactedConfig(loadConfig());
  io.err(`config file: ${cfg.path}`);
  io.err(
    JSON.stringify({ llm: cfg.llm, capture: cfg.capture, privacy: cfg.privacy }, null, 2),
  );
}
