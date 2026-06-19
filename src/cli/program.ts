import { Command } from "commander";
import { runConfig } from "./commands/config.js";
import { runDefault } from "./commands/default.js";
import { Doctor } from "./commands/doctor.js";
import { runInit } from "./commands/init.js";
import { runSetup } from "./commands/setup.js";
import type { TerminalIO } from "./io.js";

/** Build the commander program with every subcommand wired to its handler. */
export function buildProgram(io: TerminalIO): Command {
  const program = new Command();

  program
    .name("infer")
    .description("LLM-powered fix for your last failed shell command")
    .version("0.1.0", "-V, --version")
    .option("-d, --detail", "explain the failure and ask about your intent")
    .option("-v, --verbose", "log timing, connection and the exact LLM payload")
    .option("--unsafe-no-redact", "send WITHOUT redaction (dangerous; requires intent)")
    .action((opts) => runDefault(io, opts));

  program
    .command("setup")
    .description("install the shell integration into your shell rc (one line)")
    .action(() => runSetup(io));

  program
    .command("init")
    .argument("[shell]", "zsh | bash | fish")
    .description("print the shell integration snippet for eval")
    .action((shell?: string) => runInit(shell));

  program
    .command("doctor")
    .description("diagnose the installation; non-zero exit if anything is broken")
    .action(() => new Doctor(io).run());

  program
    .command("config")
    .description("print the resolved configuration")
    .option("--reset", "back up and regenerate the default config file")
    .action((opts) => runConfig(io, opts));

  return program;
}
