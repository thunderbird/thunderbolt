# ⚡ thunderbolt

A single-binary terminal coding agent. It operates directly in your working
directory with four tools — **bash**, **read**, **write**, **edit** — built on
the [Pi harness](https://www.npmjs.com/package/@earendil-works/pi-agent-core)
and talking to models from Anthropic, OpenAI, Google, xAI, and other providers.
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

Run `thunderbolt` in a terminal. When no usable API key exists, guided setup
asks for provider, API key, and model, saves defaults, then continues directly
into requested REPL or one-shot task. API key input is not echoed.

Run setup again anytime:

```sh
thunderbolt config
```

Config lives at `~/.thunderbolt/config.json`, or
`$THUNDERBOLT_HOME/config.json` when `THUNDERBOLT_HOME` is set. File mode is
`0600` because config may contain a plaintext API key.

```json
{
  "provider": "openai-compat",
  "model": "upstream-model",
  "apiKey": "sk-...",
  "baseUrl": "https://host.example/v1"
}
```

`apiKey` and `baseUrl` are optional. Saved keys apply only when saved provider
and base URL match effective provider and base URL, preventing cross-provider or
cross-endpoint credential forwarding. Missing, malformed, or invalid config is
treated as absent.

Resolution order is explicit flag, supported provider environment variable,
config file, then built-in default. Current environment tier contains credential
variables only; provider, model, and base URL have no environment override.

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
| `thunderbolt config`                                                         | Run guided provider setup and overwrite saved defaults.        |
| `thunderbolt acp serve [options]`                                            | Expose built-in coding agent as stdio ACP server.              |
| `thunderbolt acp --transport <wss\|iroh> [--port N] -- <agent-cmd...>`       | Bridge stdio ACP agent.                                        |
| `thunderbolt mcp --transport <wss\|iroh> [--port N] -- <server-cmd...>`      | Bridge stdio MCP server.                                       |
| `thunderbolt <acp\|mcp> connect <ticket\|nodeid> [-- <local-client-cmd...>]` | Dial iroh bridge.                                              |
| `thunderbolt iroh id` / `pair` / `allow <nodeid>`                            | Inspect ACP identity, print pairing ticket, or authorize peer. |

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
| `--provider <name>`  | Built-in provider or `openai-compat` (default: `anthropic`).               |
| `--base-url <url>`   | Custom endpoint URL (required for `openai-compat`).                        |
| `--api-key <key>`    | Explicit key for any provider; overrides provider environment.             |
| `--thinking <level>` | `off`, `minimal`, `low`, `medium`, `high`, or `xhigh` (default: `medium`). |
| `-y`, `--yolo`       | Auto-approve tool calls (alias: `--dangerously-skip-permissions`).         |
| `--no-tui`           | Force plain readline REPL.                                                 |
| `-h`, `--help`       | Show help and exit.                                                        |
| `-v`, `--version`    | Print version and exit.                                                    |

ACP/MCP bridge commands accept `--transport wss|iroh` (default `wss`) and
`--port <0-65535>` for WSS (defaults: ACP `8839`, MCP `8840`). Arguments after
`--` form spawned stdio command.

Supported built-in providers:

`anthropic`, `openai`, `google`, `xai`, `deepseek`, `zai`, `mistral`, `groq`,
`openrouter`, `moonshotai`, `minimax`, `cerebras`, `together`, `fireworks`.

Each built-in provider uses Pi's generated model catalog and standard API-key
environment variable. `--api-key` overrides that environment key; matching
saved config supplies fallback credentials. Unknown model errors list valid
catalog ids for selected provider.

`openai-compat` remains custom-endpoint escape hatch:

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
| `THUNDERBOLT_HOME`                           | CLI state root containing `config.json`, iroh identity/allowlist, and ACP sessions (default: `~/.thunderbolt`). |
| `THUNDERBOLT_IROH_RELAY_URL`                 | Self-hosted iroh-relay WSS URL; unset uses n0 public relays.                                                    |
| `THUNDERBOLT_APP_ORIGIN`                     | Extra comma-separated allowed browser origins for WSS bridges.                                                  |
| `THUNDERBOLT_NO_TUI`                         | Force plain readline REPL when set.                                                                             |
| `NO_COLOR`                                   | Disable terminal color when set.                                                                                |

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
