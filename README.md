# infer-cmd

**A command failed. Type `infer`. Get the fix.**

`infer` reads your last failed command and its error output, sends them to a free
LLM, and hands you the corrected command — ready to run with one keypress.

```console
$ npm run buil
npm error Missing script: "buil"

$ infer
  The script is "build", not "buil".

  → npm run build
  [Enter=run · e=edit · q=quit]
```

Works out of the box with a **free LLM (no API key, no signup)**. Switch to Groq,
OpenAI-compatible, or a local model anytime.

---

## Install

```sh
npm i --global infer-cmd
```

## Set up (one line)

Add the integration to your shell rc, then open a new shell:

```sh
# zsh  → ~/.zshrc
eval "$(infer init zsh)"

# bash → ~/.bashrc
eval "$(infer init bash)"

# fish → ~/.config/fish/config.fish
infer init fish | source
```

> Why this is needed: a shell doesn't save a command's output anywhere. The
> integration captures the command, its exit code, and the error you saw into a
> small temp file so `infer` can read them. It restores the real terminal for
> interactive programs (vim, less, ssh…) so nothing is degraded.

Verify it's working:

```sh
infer doctor
```

## First use

1. Run a command that fails.
2. Type `infer`.
3. Read the suggested fix and press **Enter** to run it (or `e` to edit, `q` to quit).

Want more than a one-liner?

```sh
infer --detail     # why it failed + other options + a question about your intent
infer --verbose    # timing, connection info, and the exact payload sent to the LLM
```

If `infer` can't confidently fix the command, it automatically falls back to the
`--detail` flow and asks you a clarifying question, then refines the fix from your answer.

---

## Switching LLM providers

The default uses **LLM7.io** — free, no key, no signup. To change models or
providers, edit `~/.infer.toml` (created automatically on first run). Any
**OpenAI-compatible** `/chat/completions` endpoint works.

| Provider | Free? | `base_url` | Notes |
|---|---|---|---|
| **LLM7** (default) | no signup, no key | `https://api.llm7.io/v1` | 30 req/min |
| **Groq** | free key | `https://api.groq.com/openai/v1` | very fast; `model="llama-3.3-70b-versatile"` |
| **OVHcloud** | no key | `https://oai.endpoints.kepler.ai.cloud.ovh.net/v1` | EU-hosted; ~2 req/min |
| **OpenRouter** | free tier | `https://openrouter.ai/api/v1` | many free models |
| **Mistral** | free key | `https://api.mistral.ai/v1` | `model="mistral-small-latest"` |
| **Ollama** (local) | local | `http://localhost:11434/v1` | offline; `model="llama3.1"` |

Example — switch to Groq:

```toml
[llm]
provider = "groq"
base_url = "https://api.groq.com/openai/v1"
model    = "llama-3.3-70b-versatile"
api_key  = "gsk_your_key_here"
```

The API key can also be supplied via the `INFER_API_KEY` environment variable,
which overrides the file. See the [awesome-free-llm-apis](https://github.com/mnfst/awesome-free-llm-apis)
list for more options.

## Commands & flags

| Command | What it does |
|---|---|
| `infer` | Suggest a fix for the last failed command. |
| `infer --detail` / `-d` | Explain the failure, list alternatives, ask your intent, then refine. |
| `infer --verbose` / `-v` | Log timing, connection, and the exact (redacted) LLM payload. |
| `infer init <zsh\|bash\|fish>` | Print the shell integration snippet for `eval`. |
| `infer doctor` | Check that the integration is active. |
| `infer config` | Print the resolved configuration (API key masked). |

## Privacy & security

`infer` sends your command and its error output to an LLM, so it is built to be
**fail-closed** about secrets:

1. **Consent before every remote send.** For any non-local provider, `infer`
   shows the **exact payload** and asks `Send this to <host>? [y/N]` before a
   single byte leaves your machine. In a non-interactive shell (pipes/CI) it
   **refuses** to send to a remote provider at all.
2. **Redaction on by default**, client-side, before the network call. Covered:
   AWS keys, OpenAI/Anthropic/GitHub/GitLab/Slack/Google/Stripe/SendGrid/HF/npm
   token formats, `Bearer`/`Authorization`/`Basic`/`Token` headers, JWTs, PEM
   private keys, `KEY=`/`SECRET:`/JSON/`--token`/`-p` credential forms,
   `user:pass@` URLs and `?password=` query params — **plus a generic
   high-entropy catch-all** for unknown token shapes. Your working directory is
   collapsed (`$HOME`→`~`) and scrubbed too.
3. **Fail-closed verification.** If redaction errors, or the result *still* looks
   like it contains a secret, `infer` refuses to send rather than risk a leak.
4. **Nothing-leaves-the-machine option.** Point `base_url` at a local model
   (e.g. Ollama, `http://localhost:11434/v1`) and there is no network egress and
   no consent prompt.

Inspect exactly what would be sent with `infer --verbose`. Redaction can be tuned
via the `[privacy]` section of `~/.infer.toml`; disabling it requires the explicit
`--unsafe-no-redact` intent and a local provider is still recommended for
sensitive work.

> **Honest caveat:** regex redaction is a denylist and cannot *prove* no secret
> ever escapes. The consent prompt (you see the payload) and the local-model
> option are the only hard guarantees; treat redaction as strong defense-in-depth.

Capture files live in `$XDG_STATE_HOME/infer/<pid>/` in a `0700` directory and are
swept on shell exit and after `INFER_TTL_MIN` minutes (default 1 day).

## Troubleshooting

- **"no recent command was captured"** → the integration isn't active. Run
  `infer doctor` and make sure the `eval` line is in your shell rc, then open a new shell.
- **Rate limited (HTTP 429)** → the free default has limits; wait a moment or
  switch providers in `~/.infer.toml`.
- **Inside tmux without integration** → `infer` will try `tmux capture-pane` as a fallback.

## Uninstall

```sh
npm rm --global infer-cmd
```

Then remove the `eval "$(infer init …)"` line from your shell rc.

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md). Releases are documented in
[ops/PUBLISHING.md](./ops/PUBLISHING.md).

## License

MIT
