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

**One-liner** (placeholder — same self-contained binary, no Bun required):

```sh
curl -fsSL https://thunderbolt.dev/install.sh | sh
```

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
