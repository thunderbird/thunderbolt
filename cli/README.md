# ⚡ thunderbolt

A single-binary terminal coding agent. It operates directly in your working
directory with five tools — **bash**, **read**, **write**, **edit**, **webfetch**
— plus provider-native web search where supported. Built on the
[Pi harness](https://www.npmjs.com/package/@earendil-works/pi-agent-core) and
talking to models from Anthropic, OpenAI, Google, xAI, and other providers.
Give it a task as one prompt or drop into an interactive REPL; there's no daemon,
and nothing to install but the binary.

## Install

**Recommended — remote installer** (macOS arm64 and Linux):

```sh
# curl
curl -fsSL https://raw.githubusercontent.com/thunderbird/thunderbolt/main/install.sh | sh
# wget
wget -qO- https://raw.githubusercontent.com/thunderbird/thunderbolt/main/install.sh | sh
```

The installer selects the correct binary, resolves the newest stable release,
verifies its SHA-256 checksum, and installs it to `~/.local/bin/thunderbolt`.
Set `THUNDERBOLT_VERSION` to install a specific release, for example:

```sh
curl -fsSL https://raw.githubusercontent.com/thunderbird/thunderbolt/main/install.sh | THUNDERBOLT_VERSION=v0.1.107 sh
```

### From source

Requires [Bun](https://bun.sh):

```sh
cd cli
bun install
bun run build      # compiles dist/thunderbolt
./install.sh       # copies it to ~/.local/bin
```

### Manual prebuilt binary

Prebuilt binaries are self-contained and require no Bun. Each release attaches
one binary per target plus a `SHA256SUMS` manifest. Pick your target
(`darwin-arm64`, `linux-x64`, or `linux-arm64` — Intel macs aren't built yet,
see below) and verify the checksum before running:

```sh
TARGET=darwin-arm64
BASE=https://github.com/thunderbird/thunderbolt/releases/latest/download

curl -fsSLO "$BASE/thunderbolt-cli-$TARGET"
curl -fsSLO "$BASE/SHA256SUMS"
grep " thunderbolt-cli-$TARGET\$" SHA256SUMS | shasum -a 256 -c -

chmod +x "thunderbolt-cli-$TARGET"
# macOS only: clear the download quarantine so Gatekeeper allows the unsigned binary
xattr -d com.apple.quarantine "thunderbolt-cli-$TARGET" 2>/dev/null || true
mv "thunderbolt-cli-$TARGET" ~/.local/bin/thunderbolt
```

> **What the checksum covers.** `SHA256SUMS` and the binary come from the same
> release over the same TLS connection, so the checksum catches a corrupted or
> truncated download but _not_ a compromised release host — whoever could swap the
> binary could swap its digest too. The binaries are unsigned and the quarantine
> strip bypasses macOS Gatekeeper. Signature verification (minisign) over the
> manifest against a pinned key is the planned follow-up hardening.

> Intel macOS (`darwin-x64`) has no binary: the CLI's `@number0/iroh` P2P addon
> ships no `x86_64-apple-darwin` build, so an Intel-mac binary can't load it.
> Windows also has no prebuilt CLI binary. Build from source above on either
> unsupported platform.

## First run

Run `thunderbolt` in a terminal. First-run setup offers two connection paths:
Interactive REPL setup stays inside the TUI; one-shot and `--no-tui` runs use the plain prompts.

- **Thunderbolt account (recommended):** opens a verification link (and prints a
  QR code) so you can approve this CLI in the web app. The resulting web session
  is bound to this CLI installation before managed inference starts.
- **Provider API key:** creates a named BYOK profile for a built-in provider or
  an OpenAI-compatible endpoint. API key input is not echoed.

Setup then continues into the requested REPL or one-shot task. Use the same
Thunderbolt account as the web app when you want managed models; no provider API
key is required for that path.

Run setup again anytime:

```sh
thunderbolt config
```

You can also manage the account session directly:

```sh
thunderbolt login
thunderbolt logout
```

When a stored web session exists, `thunderbolt logout` revokes the bound CLI
device and its web session before clearing local authentication. Removing or
revoking this CLI from the web app also invalidates its session; run
`thunderbolt login` to bind it again.

Provider configuration lives at `~/.thunderbolt/config.json`, and account
authentication has a separate file under the same directory. Set
`THUNDERBOLT_HOME` to move that state root. Files are written with mode `0600`
because BYOK profiles may contain plaintext API keys. Profiles, selected models,
and account authentication are local to this CLI installation: the CLI does not
use PowerSync and does not sync this state to other devices.

Each BYOK profile has its own stable ID, label, provider, default model, and
credential scope. Saved keys apply only to the matching provider and, for
OpenAI-compatible profiles, matching base URL. Missing or rejected credentials
can be repaired without changing another profile.

For BYOK profiles, credential resolution is explicit `--api-key`, the selected
provider's dedicated environment variable, then that profile's saved key.
Provider, model, key, and URL flags affect only the current process and are never
persisted.

## Usage

Run a single task and exit:

```sh
thunderbolt "fix the failing test in utils.ts"
```

Start an interactive session (type a task, or `exit` to quit):

```sh
thunderbolt
```

### Subcommands

| Command                                                                      | Purpose                                                        |
| ---------------------------------------------------------------------------- | -------------------------------------------------------------- |
| `thunderbolt agent [options] [prompt]`                                       | Run coding agent; `agent` is optional/default.                 |
| `thunderbolt config`                                                         | Manage the Thunderbolt account and local BYOK profiles.         |
| `thunderbolt login`                                                          | Bind this CLI to a Thunderbolt account through web login.       |
| `thunderbolt logout`                                                         | Revoke and clear the stored Thunderbolt web session.            |
| `thunderbolt acp serve [options]`                                            | Expose built-in coding agent as stdio ACP server.              |
| `thunderbolt acp --transport <wss\|iroh> [--port N] -- <agent-cmd...>`       | Bridge stdio ACP agent.                                        |
| `thunderbolt mcp --transport <wss\|iroh> [--port N] -- <server-cmd...>`      | Bridge stdio MCP server.                                       |
| `thunderbolt <acp\|mcp> connect <ticket\|nodeid> [-- <local-client-cmd...>]` | Dial iroh bridge.                                              |
| `thunderbolt iroh id` / `pair` / `allow <nodeid>`                            | Inspect ACP identity, print pairing ticket, or authorize peer. |

### Interactive commands

The TUI and plain REPL share these commands:

| Command        | Purpose                                                        |
| -------------- | -------------------------------------------------------------- |
| `/providers`   | Manage the account connection and local BYOK profiles.         |
| `/models`      | Select a model for the active provider.                        |
| `/login`       | Bind this CLI to a Thunderbolt account through web login.      |
| `/logout`      | Revoke and clear the stored Thunderbolt web session.           |
| `/permissions` | Choose any tool permission mode.                               |

While a TUI turn is running, Enter queues another message. Press ↑ to select a
queued message, then Enter to send it immediately, Backspace/Delete to remove
it, or Esc to return to the editor; interrupting a turn keeps the queue for later.

The picker always offers `ask`, `accept-edits`, `read-only`, and `yolo`. In the
TUI, Shift+Tab cycles through those modes in that order. `--yolo` only selects
the initial mode; it does not limit later switching.

### Served agent workspace

When you run `thunderbolt acp serve` directly or through a bridge, the served
agent's workspace is the directory where the bridge/serve process was launched
(`process.cwd()`). Its read, write, and edit tools can access that directory and
everything under it, but nothing outside it. Any `cwd` sent by the connecting
app is ignored.

Launch the bridge from the project you want the agent to work on:

```sh
cd ~/dev/my-project && thunderbolt acp --transport iroh -- thunderbolt acp serve
```

To span several projects, launch it from a common parent:

```sh
cd ~/dev && thunderbolt acp --transport iroh -- thunderbolt acp serve
```

The agent can then reach everything under `~/dev`, but nothing above it. Files
elsewhere on the machine are outside its workspace and unavailable.

### Agent and `acp serve` flags

| Flag                 | Description                                                                |
| -------------------- | -------------------------------------------------------------------------- |
| `-m`, `--model <id>` | Provider model id (provider-specific default).                             |
| `--provider <id>`    | Profile ID or unique provider/label shorthand for this process.           |
| `--base-url <url>`   | Custom endpoint URL (required for `openai-compat`).                        |
| `--api-key <key>`    | Compatibility-only provider key override; may leak via shell history.      |
| `--thinking <level>` | `off`, `minimal`, `low`, `medium`, `high`, or `xhigh` (default: `medium`). |
| `-y`, `--yolo`       | Start in yolo permission mode (alias: `--dangerously-skip-permissions`).   |
| `--no-tui`           | Force plain readline REPL (`agent` only).                                  |
| `--fullscreen`       | Use the alternate screen; native scrollback is unavailable (`agent` only). |
| `-h`, `--help`       | Show help and exit.                                                        |
| `-v`, `--version`    | Print version and exit.                                                    |

ACP/MCP bridge commands accept `--transport wss|iroh` (default `wss`) and
`--port <0-65535>` for WSS (defaults: ACP `8839`, MCP `8840`). Arguments after
`--` form the spawned stdio command. `wss` is the selector name for the loopback
WebSocket transport, and its advertised URL uses `ws://` on `127.0.0.1`.

Supported BYOK providers:

`anthropic`, `openai`, `google`, `xai`, `deepseek`, `zai`, `mistral`, `groq`,
`openrouter`, `moonshotai`, `minimax`, `cerebras`, `together`, `fireworks`.

Each BYOK provider uses Pi's generated model catalog and dedicated API-key
environment variable. Managed Thunderbolt models instead come from the public
backend catalog and never expose private upstream endpoints, provider
credentials, or pricing data.

`openai-compat` remains the custom-endpoint escape hatch:

```sh
THUNDERBOLT_OPENAI_COMPAT_KEY=sk-... thunderbolt \
  --provider openai-compat \
  --base-url http://localhost:11434/v1 \
  --model llama3.3 \
  "review this repository"
```

For security, `openai-compat` never reads `OPENAI_API_KEY` or another generic
provider key. Use `--api-key` or `THUNDERBOLT_OPENAI_COMPAT_KEY` explicitly so a
credential cannot be forwarded automatically to an arbitrary custom URL.

### Provider defaults

| Provider     | Default model                              |
| ------------ | ------------------------------------------ |
| `anthropic`  | `claude-opus-4-8`                          |
| `openai`     | `gpt-5.6-sol`                              |
| `google`     | `gemini-3.1-pro-preview`                   |
| `xai`        | `grok-build-0.1`                           |
| `deepseek`   | `deepseek-v4-pro`                          |
| `zai`        | `glm-5.2`                                  |
| `mistral`    | `devstral-medium-latest`                   |
| `groq`       | `openai/gpt-oss-120b`                      |
| `openrouter` | `anthropic/claude-opus-4.8`                |
| `moonshotai` | `kimi-k2.7-code`                           |
| `minimax`    | `MiniMax-M3`                               |
| `cerebras`   | `gpt-oss-120b`                             |
| `together`   | `moonshotai/Kimi-K2.7-Code`                |
| `fireworks`  | `accounts/fireworks/models/kimi-k2p7-code` |

### Environment

| Variable                                     | Description                                                                                                     |
| -------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `ANTHROPIC_OAUTH_TOKEN`, `ANTHROPIC_API_KEY` | Anthropic credentials, checked in that order.                                                                   |
| `OPENAI_API_KEY`                             | OpenAI API key.                                                                                                 |
| `GEMINI_API_KEY`                             | Google Gemini API key.                                                                                          |
| `XAI_API_KEY`                                | xAI API key.                                                                                                    |
| `DEEPSEEK_API_KEY`                           | DeepSeek API key.                                                                                               |
| `ZAI_API_KEY`                                | Z.AI API key.                                                                                                   |
| `MISTRAL_API_KEY`                            | Mistral API key.                                                                                                |
| `GROQ_API_KEY`                               | Groq API key.                                                                                                   |
| `OPENROUTER_API_KEY`                         | OpenRouter API key.                                                                                             |
| `MOONSHOT_API_KEY`                           | Moonshot AI API key.                                                                                            |
| `MINIMAX_API_KEY`                            | MiniMax API key.                                                                                                |
| `CEREBRAS_API_KEY`                           | Cerebras API key.                                                                                               |
| `TOGETHER_API_KEY`                           | Together API key.                                                                                               |
| `FIREWORKS_API_KEY`                          | Fireworks API key.                                                                                              |
| `THUNDERBOLT_OPENAI_COMPAT_KEY`              | Dedicated fallback key for arbitrary `openai-compat` URLs.                                                      |
| `THUNDERBOLT_HOME`                           | CLI state root containing provider config, account auth, iroh identity/allowlist, and ACP sessions (default: `~/.thunderbolt`). |
| `THUNDERBOLT_CLOUD_URL`                      | Thunderbolt backend the CLI talks to (local-build default: `http://localhost:8000/v1`). Point it at your cloud or self-hosted `…/v1` base before `thunderbolt login`; the URL is persisted alongside the credential, so later commands need no env. |
| `THUNDERBOLT_APP_URL`                        | Thunderbolt app base used in bridge pairing instructions (local-build default: `http://localhost:1420`).        |
| `THUNDERBOLT_TOKEN`                          | Personal access token for headless direct managed inference and bridges only. It cannot use confidential GLM, bind a CLI device, or be cleared by `thunderbolt logout`; remove it from the environment or revoke it in the web account. Resolves the backend from `THUNDERBOLT_CLOUD_URL` on every run. |
| `THUNDERBOLT_IROH_RELAY_URL`                 | Self-hosted iroh-relay WSS URL; unset uses n0 public relays.                                                    |
| `THUNDERBOLT_APP_ORIGIN`                     | Extra comma-separated allowed browser origins for WSS bridges.                                                  |
| `THUNDERBOLT_NO_TUI`                         | Force plain readline REPL when set.                                                                             |
| `NO_COLOR`                                   | Disable terminal color when set.                                                                                |

Official release binaries bake production cloud and app defaults; runtime `THUNDERBOLT_CLOUD_URL` and `THUNDERBOLT_APP_URL` overrides still win.

`THUNDERBOLT_TOKEN` takes precedence over a stored web session for the current
process. PATs support direct managed models only. Confidential GLM uses
session-bound cache material and therefore requires `thunderbolt login`; the CLI
returns `WEB_LOGIN_REQUIRED` instead of falling back to direct inference or a
BYOK provider.

## Demo

```sh
export ANTHROPIC_API_KEY=sk-ant-...

thunderbolt "summarize what this repo does in three bullets"
thunderbolt --thinking high "find and fix the off-by-one bug in src/range.ts"
thunderbolt --yolo "run the test suite and fix whatever breaks"

# Or select another built-in provider; omitted --model uses provider default.
OPENAI_API_KEY=sk-... thunderbolt --provider openai "fix the failing tests"
thunderbolt --provider google --api-key AIza... "review this repository"
```
