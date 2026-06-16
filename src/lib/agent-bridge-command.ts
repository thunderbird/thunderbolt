/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { RegistryEntry } from '@/types/registry'

/**
 * Derives the shell commands shown in the catalogue's "Connect via bridge"
 * dialog, composed purely from a registry entry's `distribution`. These are
 * display strings the user copies into their own terminal — nothing executes
 * them here, so there's no shell-injection surface to guard against.
 *
 * Two flavours are produced from the same launch command:
 *   - the install/launch command (`npx <package> <args>` / `uvx <package> <args>`),
 *   - the bridge command that wraps it (`npx acp-bridge -- <launch command>`).
 *
 * `binary` distributions have no portable launch line (the registry leaves the
 * shape opaque per platform), so both helpers return `null` and the UI points
 * the user at the agent's own site/repo instead.
 */

/** Build the `<package> <args...>` fragment for an npx/uvx distribution. */
const launchArgs = (pkg: string, args: ReadonlyArray<string> | undefined): string => [pkg, ...(args ?? [])].join(' ')

/**
 * The bare command a user runs to launch the agent on their own machine, e.g.
 * `npx @agentclientprotocol/claude-agent-acp`. Returns `null` for `binary`
 * distributions, which the registry leaves opaque per platform.
 */
export const composeLaunchCommand = (entry: RegistryEntry): string | null => {
  const { npx, uvx } = entry.distribution
  if (npx) {
    return `npx ${launchArgs(npx.package, npx.args)}`
  }
  if (uvx) {
    return `uvx ${launchArgs(uvx.package, uvx.args)}`
  }
  return null
}

/**
 * The command to install the agent — identical to the launch command (npx/uvx
 * fetch-and-run on first use), surfaced separately so the dialog can label the
 * "install" and "run the bridge" steps independently. Returns `null` for
 * `binary` distributions.
 */
export const composeInstallCommand = (entry: RegistryEntry): string | null => composeLaunchCommand(entry)

/**
 * The `acp-bridge` invocation that relays the local stdio agent to a localhost
 * WebSocket: `npx acp-bridge -- <launch command>`. Everything after `--` is the
 * agent's own launch argv. Returns `null` for `binary` distributions.
 */
export const composeBridgeCommand = (entry: RegistryEntry): string | null => {
  const launch = composeLaunchCommand(entry)
  if (!launch) {
    return null
  }
  return `npx acp-bridge -- ${launch}`
}
