/** A captured failed command, read from the shell-integration session dir. */
export interface CaptureRecord {
  /** The command line that was run. */
  command: string;
  /** Exit code of the command (non-zero = failure). */
  exitCode: number;
  /** Working directory the command ran in. */
  cwd: string;
  /** Cleaned (ANSI-stripped, redacted, capped) combined stdout+stderr. */
  output: string;
  /** Where the capture came from: shell integration, tmux fallback, or none. */
  source: "integration" | "tmux" | "none";
  /**
   * False when redaction failed or could not be verified clean. The send path
   * MUST refuse to transmit a record that is not `safe`.
   */
  safe: boolean;
}

/** Resolved LLM provider configuration. */
export interface ProviderConfig {
  provider: string;
  baseUrl: string;
  model: string;
  apiKey: string;
  temperature: number;
  maxTokens: number;
}

/** Full resolved config. */
export interface InferConfig {
  llm: ProviderConfig;
  capture: {
    maxBytes: number;
    /** Extra commands to exclude from output capture (need a real TTY). */
    deny: string[];
  };
  privacy: { redact: boolean };
  /** Absolute path of the config file (existing or to-be-created). */
  path: string;
}

/** Structured reply for the default (tl;dr) flow. */
export interface LlmFixResult {
  fix: string | null;
  confident: boolean;
  reason: string;
}

/** Structured reply for the --detail flow. */
export interface LlmDetailResult {
  why: string;
  alternatives: string[];
  intentQuestion: string;
}

/** Options that flow through the command pipeline. */
export interface RunOptions {
  detail: boolean;
  verbose: boolean;
  /** Explicit per-invocation opt-in to send WITHOUT redaction (dangerous). */
  unsafeNoRedact?: boolean;
}
