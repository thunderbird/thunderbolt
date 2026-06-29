/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Shell-command composers for the bridge connect flow.
 *
 * A catalogue agent is a local CLI (npx / uvx / binary). To reach it from the
 * app the user runs `thunderbolt bridge`, which spawns the agent's CLI and exposes it
 * over a loopback WebSocket (`ws://127.0.0.1:PORT`). These helpers build the
 * three copyable commands the connect dialog walks the user through:
 *
 *   1. install the bridge (`composeInstallCommand`)
 *   2. run the bridge wrapping the agent (`composeBridgeCommand`)
 *   3. (the launch fragment alone, `composeLaunchCommand`, for display/tests)
 *
 * Binary-distributed agents have no portable one-line launch, so
 * `composeBridgeCommand` returns `null` for them and the UI points the user at
 * the agent's own site/repo instead.
 */

import { isLoopbackUrl } from '@/acp/transports/is-loopback'
import type { RegistryEntry } from '@/types/registry'

/** The command name the app's `install.sh` installs onto PATH. The bridge is a
 *  subcommand of this binary (`thunderbolt bridge …`). */
const bridgeBin = 'thunderbolt'

/** Canonical one-line installer, wrapped in `bash -c 'set -o pipefail; …'` so a
 *  failed `curl` (404 / network) fails the whole pipeline instead of leaving the
 *  exit status at 0 — without pipefail a broken download looks like a successful
 *  install. The `bash -c` wrapper also makes the pasted command shell-agnostic
 *  (bash/zsh/fish all just exec it). This is the exact effective auto-install
 *  command the desktop runs via `THUNDERBOLT_INSTALL_CMD` in `src-tauri/src/commands.rs`
 *  (which wraps the same script in `bash -c 'set -o pipefail; …'`); keep in sync. */
const installCommand =
  "bash -c 'set -o pipefail; curl -fsSL https://raw.githubusercontent.com/thunderbird/thunderbolt/main/cli/install.sh | bash'"

/**
 * The shell fragment that launches the agent's own CLI, e.g.
 * `npx @google/gemini-cli@0.46.0 --acp` or `uvx fast-agent ...`. Returns `null`
 * for binary distributions (no portable runner) — the UI falls back to the
 * agent's site/repo. Prefers npx over uvx, matching `primaryDistributionKind`.
 */
export const composeLaunchCommand = (entry: RegistryEntry): string | null => {
  const npx = entry.distribution.npx
  if (npx) {
    return ['npx', npx.package, ...(npx.args ?? [])].join(' ')
  }
  const uvx = entry.distribution.uvx
  if (uvx) {
    return ['uvx', uvx.package, ...(uvx.args ?? [])].join(' ')
  }
  return null
}

/** The curl | bash command that installs the bridge onto the user's PATH. */
export const composeInstallCommand = (): string => installCommand

/**
 * Whether a copied bridge command needs an explicit `--allow-origin`: only for a
 * valid, non-loopback http(s) app origin (production web). Opaque origins (the
 * literal `'null'`, `file:`, sandboxed frames) and loopback origins need nothing
 * — the bridge's default allowlist already accepts loopback and absent Origins.
 */
const needsAllowOrigin = (origin: string | undefined): origin is string => {
  if (!origin) {
    return false
  }
  try {
    const { protocol } = new URL(origin)
    return (protocol === 'http:' || protocol === 'https:') && !isLoopbackUrl(origin)
  } catch {
    return false
  }
}

/**
 * Build a `thunderbolt bridge --mode <mode> -- <launch>` command for an already-resolved
 * launch fragment, or `null` when there's nothing to wrap. `thunderbolt` is the bare
 * binary `install.sh` drops on PATH — invoked directly (no `npx`, which would hit
 * the registry since the binary is never published to npm).
 *
 * When `origin` is a non-loopback app origin (production web), the bridge's
 * default loopback-only Origin allowlist would reject the browser's request, so
 * we add `--allow-origin '<origin>'`. A loopback origin (or none) needs nothing
 * extra — the default allowlist already accepts loopback.
 */
const composeBridge = (mode: 'acp' | 'mcp', launch: string | null, origin?: string): string | null => {
  if (!launch) {
    return null
  }
  const allowOrigin = needsAllowOrigin(origin) ? `--allow-origin '${origin}' ` : ''
  return `${bridgeBin} bridge --mode ${mode} ${allowOrigin}-- ${launch}`
}

/**
 * The full ACP bridge command for a catalogue agent: `thunderbolt bridge --mode acp --
 * <launch>`. Returns `null` when the agent only ships a binary distribution (no
 * composable launch fragment), so the dialog can render its binary fallback. The
 * catalogue is ACP-only, so `--mode acp` is always correct here.
 */
export const composeBridgeCommand = (entry: RegistryEntry, origin?: string): string | null =>
  composeBridge('acp', composeLaunchCommand(entry), origin)

/**
 * The full bridge command for a local stdio MCP server: `thunderbolt bridge --mode mcp
 * -- <command>`. Returns `null` for a blank command. The bridge serves the
 * wrapped server over a loopback `http://127.0.0.1:PORT/mcp` endpoint the user
 * then adds as a remote MCP server (the loopback carve-out lets the app reach
 * it). `origin` adds `--allow-origin` for production web, as in
 * `composeBridgeCommand`.
 */
export const composeMcpBridgeCommand = (stdioCommand: string, origin?: string): string | null =>
  composeBridge('mcp', stdioCommand.trim() || null, origin)
