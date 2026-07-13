# ⚡ thunderbolt

A single-binary terminal coding agent. It operates directly in your working
directory with four tools — **bash**, **read**, **write**, **edit** — built on
the [Pi harness](https://www.npmjs.com/package/@earendil-works/pi-agent-core)
and talking to Claude. Give it a task as one prompt or drop into an interactive
REPL; there's no daemon, no config file, and nothing to install but the binary.

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
> truncated download but *not* a compromised release host — whoever could swap the
> binary could swap its digest too. The binaries are unsigned and the quarantine
> strip bypasses macOS Gatekeeper. Signature verification (minisign) over the
> manifest against a pinned key is the planned follow-up hardening.

> Intel macOS (`darwin-x64`) has no binary: the CLI's `@number0/iroh` P2P addon
> ships no `x86_64-apple-darwin` build, so an Intel-mac binary can't load it.
> Windows also has no prebuilt CLI binary. Build from source above on either
> unsupported platform.

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

| Command | Purpose |
| ------- | ------- |
| `thunderbolt agent [options] [prompt]` | Run coding agent; `agent` is optional/default. |
| `thunderbolt acp serve [options]` | Expose built-in coding agent as stdio ACP server. |
| `thunderbolt acp --transport <wss\|iroh> [--port N] -- <agent-cmd...>` | Bridge stdio ACP agent. |
| `thunderbolt mcp --transport <wss\|iroh> [--port N] -- <server-cmd...>` | Bridge stdio MCP server. |
| `thunderbolt <acp\|mcp> connect <ticket\|nodeid> [-- <local-client-cmd...>]` | Dial iroh bridge. |
| `thunderbolt iroh id` / `pair` / `allow <nodeid>` | Inspect ACP identity, print pairing ticket, or authorize peer. |

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

| Flag | Description |
| ---- | ----------- |
| `-m`, `--model <id>` | Provider model id (default: `claude-opus-4-8`). |
| `--provider <provider>` | `anthropic` or `openai-compat` (default: `anthropic`). |
| `--base-url <url>` | Required OpenAI-compatible endpoint URL. |
| `--api-key <key>` | OpenAI-compatible bearer key; overrides `THUNDERBOLT_OPENAI_COMPAT_KEY`. |
| `--thinking <level>` | `off`, `minimal`, `low`, `medium`, `high`, or `xhigh` (default: `medium`). |
| `-y`, `--yolo` | Auto-approve tool calls (alias: `--dangerously-skip-permissions`). |
| `--no-tui` | Force plain readline REPL. |
| `-h`, `--help` | Show help and exit. |
| `-v`, `--version` | Print version and exit. |

ACP/MCP bridge commands accept `--transport wss|iroh` (default `wss`) and
`--port <0-65535>` for WSS (defaults: ACP `8839`, MCP `8840`). Arguments after
`--` form spawned stdio command.

Anthropic provider requires **`ANTHROPIC_API_KEY`**. OpenAI-compatible provider
requires `--base-url` plus `--api-key` or `THUNDERBOLT_OPENAI_COMPAT_KEY`.

### Environment

| Variable | Description |
| -------- | ----------- |
| `ANTHROPIC_API_KEY` | Anthropic API key for default provider. |
| `THUNDERBOLT_OPENAI_COMPAT_KEY` | Bearer key for OpenAI-compatible provider. |
| `THUNDERBOLT_HOME` | CLI state root (default `~/.thunderbolt`): iroh identity/allowlist and ACP sessions. |
| `THUNDERBOLT_IROH_RELAY_URL` | Self-hosted iroh-relay WSS URL; unset uses n0 public relays. |
| `THUNDERBOLT_APP_ORIGIN` | Extra comma-separated allowed browser origins for WSS bridges. |
| `THUNDERBOLT_NO_TUI` | Force plain readline REPL when set. |
| `NO_COLOR` | Disable terminal color when set. |

## Demo

```sh
export ANTHROPIC_API_KEY=sk-ant-...

thunderbolt "summarize what this repo does in three bullets"
thunderbolt --thinking high "find and fix the off-by-one bug in src/range.ts"
thunderbolt --yolo "run the test suite and fix whatever breaks"
```
