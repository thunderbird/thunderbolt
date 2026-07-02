# ⚡ thunderbolt

A single-binary terminal coding agent. It operates directly in your working
directory with four tools — **bash**, **read**, **write**, **edit** — built on
the [Pi harness](https://www.npmjs.com/package/@earendil-works/pi-agent-core)
and talking to Claude. Give it a task as one prompt or drop into an interactive
REPL; there's no daemon, no config file, and nothing to install but the binary.

## Install

**From source** (requires [Bun](https://bun.sh)):

```sh
cd cli
bun install
bun run build      # compiles dist/thunderbolt
./install.sh       # copies it to ~/.local/bin
```

**Prebuilt binary** (self-contained, no Bun required). Each release attaches one
binary per target plus a `SHA256SUMS` manifest. Pick your target
(`darwin-arm64`, `linux-x64`, or `linux-arm64` — Intel macs aren't built yet,
see below) and verify the checksum before running:

```sh
TARGET=darwin-arm64
BASE=https://github.com/thunderbird/thunderbolt/releases/latest/download

curl -fsSLO "$BASE/thunderbolt-$TARGET"
curl -fsSLO "$BASE/SHA256SUMS"
grep " thunderbolt-$TARGET\$" SHA256SUMS | shasum -a 256 -c -

chmod +x "thunderbolt-$TARGET"
# macOS only: clear the download quarantine so Gatekeeper allows the unsigned binary
xattr -d com.apple.quarantine "thunderbolt-$TARGET" 2>/dev/null || true
mv "thunderbolt-$TARGET" ~/.local/bin/thunderbolt
```

> Intel macOS (`darwin-x64`) has no binary: the CLI's `@number0/iroh` P2P addon
> ships no `x86_64-apple-darwin` build, so an Intel-mac binary can't load it.
> Build from source above until iroh adds that target.

## Usage

Run a single task and exit:

```sh
thunderbolt "fix the failing test in utils.ts"
```

Start an interactive session (type a task, or `exit` to quit):

```sh
thunderbolt
```

### Flags

| Flag                  | Description                                                        |
| --------------------- | ----------------------------------------------------------------- |
| `-m`, `--model <id>`  | Anthropic model id (default: `claude-opus-4-8`)                   |
| `--thinking <level>`  | Reasoning depth: `off`, `minimal`, `low`, `medium`, `high`, `xhigh` (default: `medium`) |
| `-y`, `--yolo`        | Auto-approve every tool call (alias: `--dangerously-skip-permissions`) |
| `-h`, `--help`        | Show help and exit                                                |
| `-v`, `--version`     | Print the version and exit                                        |

Requires **`ANTHROPIC_API_KEY`** in your environment
(https://console.anthropic.com).

### Environment

| Variable                      | Description                                                                 |
| ----------------------------- | --------------------------------------------------------------------------- |
| `ANTHROPIC_API_KEY`           | Anthropic API key (required).                                               |
| `THUNDERBOLT_IROH_RELAY_URL`  | iroh relay for the `bridge` transport. Unset = the n0 public relays (default); set to a self-hosted iroh-relay wss URL to override. n0 DNS discovery + crypto are kept — only the relay hop changes. Read at runtime (no rebuild). |

## How it maps to the proposal

Part 1 — the Pi harness is the engine that runs the agent loop and the four
tools. Part 3 — `thunderbolt agent` is the default (and only) subcommand, so
plain `thunderbolt` *is* the agent.

## Demo

```sh
export ANTHROPIC_API_KEY=sk-ant-...

thunderbolt "summarize what this repo does in three bullets"
thunderbolt --thinking high "find and fix the off-by-one bug in src/range.ts"
thunderbolt --yolo "run the test suite and fix whatever breaks"
```
