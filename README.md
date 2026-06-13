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

## Set up (10 seconds)

```sh
infer setup
```

That detects your shell, shows you the one line it wants to add to your rc file,
and asks before touching anything. Then open a **new** terminal. Done.

<details>
<summary>Prefer to add the line yourself?</summary>

```sh
# zsh  → ~/.zshrc
command -v infer >/dev/null && eval "$(infer init zsh)"

# bash → ~/.bashrc (macOS: ~/.bash_profile)
command -v infer >/dev/null && eval "$(infer init bash)"

# fish → ~/.config/fish/config.fish
command -q infer; and infer init fish | source
```

The `command -v` guard means your shell never breaks if you uninstall infer.
</details>

> Why this is needed: a shell doesn't save a command's output anywhere. The
> integration captures the command, its exit code, and the error you saw into a
> small temp file so `infer` can read them. It restores the real terminal for
> interactive programs (vim, less, ssh, REPLs, AI CLIs…) so nothing is degraded —
> see [Interactive programs & the capture denylist](#interactive-programs--the-capture-denylist).

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
| `infer setup` | Install the shell integration for you (asks first; idempotent). |
| `infer init <zsh\|bash\|fish>` | Print the shell integration snippet for `eval`. |
| `infer doctor` | Full health check with a copy-paste fix for every problem; exit 1 if broken. |
| `infer config` | Print the resolved configuration (API key masked). |
| `infer config --reset` | Back up and regenerate a default config (fixes broken TOML). |

### Guardrails when running fixes

- At the run prompt, **only Enter / `y` / `yes` runs** the command — any other
  answer cancels. `e` edits, `q` quits.
- Destructive suggestions (`rm -rf`, `git push --force`, `terraform destroy`,
  `curl … | sh`, sudo, …) require typing the full word **`yes`**.
- Multi-line fixes or fixes containing command substitution are **never offered
  to run** — they're shown for reference only. This also defends against prompt
  injection hiding in error output.

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

## Interactive programs & the capture denylist

The integration routes your command output through a pipe so `infer` can read it.
That pipe makes stdout look non-interactive, which breaks REPLs, TUIs, and tools
that change behavior when stdout isn't a terminal — for example `claude` would
error with *"Input must be provided…"*. To prevent this, `infer` keeps a
**denylist** of programs that always run with the real terminal restored.

A broad set of defaults ships built in — editors (vim, nano, emacs…), pagers
(less, man…), monitors (htop, btop…), file managers (ranger, nnn…), multiplexers
and remote sessions (tmux, ssh, mosh…), git/docker/k8s TUIs (lazygit, k9s…),
database clients (psql, mysql, mongosh…), language REPLs (python, node, irb,
ghci, iex…), debuggers (gdb, lldb), TUI mail/chat/browsers (mutt, w3m…), and AI
CLIs (claude, aider, gemini, ollama…).

To cover a tool that isn't built in, extend the list — both additions are
**merged** with the defaults; neither replaces them:

```toml
# ~/.infer.toml — applies to every new shell
[capture]
deny = ["mytool", "anothertool"]
```

```sh
# or per-shell at runtime (space- or comma-separated), e.g. in your rc:
export INFER_DENY="mytool anothertool"
```

Names are matched against the command's basename and restricted to
`[A-Za-z0-9._-]`; anything else is ignored. Config changes take effect in **new**
shells (the snippet is regenerated on startup). Run `infer config` to see the
resolved list. *(The denylist applies to zsh and bash; fish doesn't pipe output,
so it has nothing to exclude.)*

## Troubleshooting

- **"no recent command was captured"** → the integration isn't active. Run
  `infer doctor` and make sure the `eval` line is in your shell rc, then open a new shell.
- **An interactive tool misbehaves under infer** (no colors, no prompt, "must
  provide input…") → add its command name to `[capture] deny` or `INFER_DENY`
  (see above), then open a new shell.
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
