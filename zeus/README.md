<!-- This Source Code Form is subject to the terms of the Mozilla Public
   - License, v. 2.0. If a copy of the MPL was not distributed with this
   - file, You can obtain one at http://mozilla.org/MPL/2.0/. -->

# zeus

`zeus` is Thunderbolt's local stdio bridge toolkit. Its `bridge` subcommand
bridges a local **stdio** ACP or MCP server to a **loopback** network face so a
browser app can talk to it:

- `--mode acp` — exposes the child over a **WebSocket** (`ws://127.0.0.1:PORT`).
  Child stdout/stdin (NDJSON JSON-RPC) is pumped to/from a single WS client.
- `--mode mcp` — exposes the child over **Streamable HTTP**
  (`http://127.0.0.1:PORT/mcp`) using the official `@modelcontextprotocol/sdk`.

Everything the bridge needs to report — the readiness URL, warnings, the tunnel
URL, the generated bearer — goes to **stderr**. The bridge writes **nothing** to
its own stdout (the single exception is `--help`/`--version` text), so a parent
that treats the bridge as a stdio child can never have its framing corrupted.

## Usage

```
zeus <command> [options]
zeus bridge --mode <acp|mcp> [options] -- <launch> [args...]
```

Everything after the first bare `--` is the child launch argv, passed verbatim
to `spawn`.

```sh
# ACP: bridge a local stdio ACP agent to a loopback WebSocket
zeus bridge --mode acp -- node my-acp-agent.js
# stderr: ws://127.0.0.1:54123

# MCP: bridge a local stdio MCP server to a loopback HTTP face
zeus bridge --mode mcp -- npx @modelcontextprotocol/server-everything
# stderr: http://127.0.0.1:54124/mcp

# MCP behind a public cloudflared quick tunnel (mints a mandatory bearer)
zeus bridge --mode mcp --tunnel -- npx some-mcp-server
```

### `zeus bridge` options

| Flag                 | Default     | Meaning                                                           |
| -------------------- | ----------- | ----------------------------------------------------------------- |
| `--mode <acp\|mcp>`  | _required_  | Which face to stand up.                                            |
| `--host <h>`         | `127.0.0.1` | Bind host. Non-loopback hosts trigger loud warnings.              |
| `--port <n>`         | `0`         | Bind port. `0` lets the OS assign an ephemeral port.             |
| `--allow-origin <o>` | —           | Add an allowed browser `Origin` (repeatable).                     |
| `--allow-any-origin` | off         | Disable the Origin gate entirely (warns loudly).                  |
| `--tunnel`           | off         | MCP only. Front the face with a cloudflared quick tunnel.        |
| `--json`             | off         | Emit machine-readable JSON log lines (one object per line).      |
| `--verbose`          | off         | Emit verbose diagnostic detail.                                   |
| `--help`, `-h`       | —           | Print usage to stdout and exit `0`.                               |
| `--version`, `-V`    | —           | Print the version to stdout and exit `0`.                         |

### Exit codes (sysexits)

| Code  | Meaning                                                            |
| ----- | ----------------------------------------------------------------- |
| `0`   | Clean exit (child exited 0, `--help`, `--version`).               |
| `64`  | Usage error (bad/missing flags, empty launch argv).               |
| `69`  | Unavailable (cannot bind, spawn `ENOENT`, cloudflared missing).   |
| `70`  | Internal error (unexpected/uncaught).                             |
| `130` | Interrupted by `SIGINT`.                                          |

On any nonzero exit the bridge **SIGKILLs a live child first** — it never
orphans the process it spawned, and it never restarts it.

## Security

- **Origin gate is default-ON.** Browser WS upgrades / HTTP requests are checked
  against an allowlist (loopback origins plus any explicit `--allow-origin`).
  `--allow-any-origin` disables the gate and warns.
- **Non-loopback binds always warn loudly.** Any `--host` that isn't loopback
  emits a `DANGER` warning on its own — independent of `--allow-any-origin` —
  because clients without an `Origin` header (curl, local tools) bypass the
  Origin gate, and without `--tunnel` local mode mints no bearer, so a public
  bind is reachable from the LAN unauthenticated (with `--tunnel` the mandatory
  bearer still gates every request). Adding `--allow-any-origin` stacks its own
  warning on top.
- **`--tunnel` mints a mandatory bearer.** The bearer is high-entropy, printed
  to **stderr only**, never embedded in the public URL or any query string, and
  checked in constant time before any routing.
- **PII-safe logging.** Only allowlisted scalars are logged (method name, id
  shape, origin, host, port, exit/error codes). Raw ACP/MCP frame bodies are
  **never** logged.

## Installation

`zeus` ships as a single self-contained `zeus.cjs` attached to a GitHub
release — there is **no npm publish**. `install.sh` downloads that artifact and
links it onto your `PATH` as `zeus`:

```sh
curl -fsSL https://raw.githubusercontent.com/thunderbird/thunderbolt/main/zeus/install.sh | bash
```

The app invokes the published binary as `zeus bridge ...`.

## Building

`bun run build` runs `scripts/build-cli.mjs`, which bundles the CLI with esbuild
into `dist/zeus.cjs` (Node 18 target, `bufferutil`/`utf-8-validate` left
external, the version inlined from `package.json`, shebang prepended) and emits a
companion Windows `dist/zeus.cmd` launcher.

## Development

```sh
bun test          # run the unit + offline-tolerant integration suite
```

Every external effect (spawn, the WebSocket server, `http.createServer`, the MCP
transport, the line reader, `process.exit`) is dependency-injected, so the unit
tests fake them with **zero real sockets**. The one integration test
(`src/mcp-server.integration.test.js`) drives the real
`@modelcontextprotocol/server-everything` through the official MCP client and
**skips gracefully** when the dependency or network is unavailable.
