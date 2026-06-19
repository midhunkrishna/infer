import { enforceEnvironment } from "./cli/guards.js";
import { TerminalIO } from "./cli/io.js";
import { buildProgram } from "./cli/program.js";

// Fail early with clear words if the runtime/platform is unsupported.
enforceEnvironment();

const io = new TerminalIO();

// The persistent readline interface keeps stdin referenced; close it once the
// command finishes so the process can exit cleanly.
buildProgram(io)
  .parseAsync(process.argv)
  .finally(() => io.close());
