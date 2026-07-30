/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Direct E2B provisioning for OpenClaw — no `SandboxProvider` abstraction yet
 * (that seam, and other providers, come later). Each deploy is a Firecracker
 * microVM from one static, prebuilt E2B template that bakes the OpenClaw stack
 * (onboard + gateway + ACP↔WS shim) plus its entrypoint script.
 *
 * Ownership lives in the sandbox's own metadata (E2B is the source of truth, the
 * way Deepset is for Haystack): the deploy stamps `{ userId }`, and every relay /
 * status lookup rejects unless that stamp matches the authenticated caller — so a
 * forged `?instance=` can never reach another tenant's sandbox, even after a
 * backend restart. No backend instance table.
 */

import { Sandbox } from 'e2b'
import { probeAcpReady } from './readiness'

/** Internal port the sandbox's ACP↔WS shim listens on (baked into the template entrypoint). */
const acpPort = 8790
/**
 * Boots the OpenClaw stack. The template bakes this script but no start command
 * (E2B validates start commands at build time, yet the entrypoint needs the
 * runtime OpenRouter key), so we invoke it at deploy with the key in `envs`.
 *
 * A short-lived `sh -c` backgrounds a fully-detached (`setsid nohup … &`) daemon,
 * then exits after a beat. This survives the deploy RPC ending: without `setsid`
 * the entrypoint's final `exec bun shim` is the command's foreground process,
 * which E2B tears down when the RPC completes — killing the shim (port 8790)
 * while the backgrounded gateway lingers, so the relay could never reach the
 * sandbox. The trailing `sleep` lets the background stream establish and close
 * cleanly, avoiding an instant-exit "socket closed unexpectedly" from the SDK.
 */
const entrypointCommand =
  "sh -c 'setsid nohup bash /opt/docker-entrypoint.sh >/tmp/openclaw-boot.log 2>&1 </dev/null & sleep 2'"
/** Metadata key carrying the owning user's id — the relay's tenant-isolation gate. */
const ownerMetadataKey = 'userId'
/**
 * Hardcoded while E2B is the only sandbox backend. When the sandbox-provider seam
 * lands these become per-provider config (template id + lifetime) rather than
 * constants baked here.
 */
const openclawTemplate = 'thunderbolt-openclaw'
const sandboxTimeoutMs = 3_600_000

/** A provisioned OpenClaw sandbox (backend-side). `wsUrl` is the in-sandbox ACP endpoint the relay dials. */
export type OpenclawSandbox = { sandboxId: string; wsUrl: string }

/** Everything a deploy needs; mapped from settings at the call site so this module stays settings-agnostic. */
export type OpenclawE2bConfig = {
  apiKey: string
  model: string
  openrouterApiKey: string
}

/** Normalized status of a deployed sandbox, mapped onto the wire `DeployStatus` by the provider. */
export type OpenclawSandboxStatus = 'running' | 'pending' | 'gone'

/**
 * Minimal slice of the E2B `Sandbox` API this module uses, declared as an
 * injectable seam so unit tests drive deploy/resolve without the network.
 * {@link defaultE2bClient} adapts the real SDK.
 */
export type E2bSandbox = {
  sandboxId: string
  getHost: (port: number) => string
  commands: { run: (cmd: string, opts: { background?: boolean; envs?: Record<string, string> }) => Promise<unknown> }
  kill: () => Promise<unknown>
}
export type E2bClient = {
  create: (
    template: string,
    opts: {
      apiKey: string
      timeoutMs: number
      secure: boolean
      metadata: Record<string, string>
      envs: Record<string, string>
    },
  ) => Promise<E2bSandbox>
  connect: (sandboxId: string, opts: { apiKey: string }) => Promise<E2bSandbox>
  /** The sandbox's saved metadata, or null if it no longer exists (killed/expired). */
  getMetadata: (sandboxId: string, opts: { apiKey: string }) => Promise<Record<string, string> | null>
  kill: (sandboxId: string, opts: { apiKey: string }) => Promise<void>
}

const toSandbox = (sbx: Sandbox): E2bSandbox => ({
  sandboxId: sbx.sandboxId,
  getHost: (port) => sbx.getHost(port),
  commands: { run: (cmd, opts) => sbx.commands.run(cmd, opts) },
  kill: () => sbx.kill(),
})

/** Default client backed by the real e2b SDK. */
export const defaultE2bClient: E2bClient = {
  create: async (template, opts) =>
    toSandbox(
      await Sandbox.create(template, {
        apiKey: opts.apiKey,
        timeoutMs: opts.timeoutMs,
        secure: opts.secure,
        metadata: opts.metadata,
        envs: opts.envs,
      }),
    ),
  connect: async (sandboxId, opts) => toSandbox(await Sandbox.connect(sandboxId, { apiKey: opts.apiKey })),
  getMetadata: async (sandboxId, opts) => {
    try {
      const info = await Sandbox.getInfo(sandboxId, { apiKey: opts.apiKey })
      return info.metadata
    } catch {
      return null
    }
  },
  kill: async (sandboxId, opts) => {
    await Sandbox.kill(sandboxId, { apiKey: opts.apiKey }).catch(() => {})
  },
}

export type OpenclawE2bDeps = {
  client?: E2bClient
  /** ACP readiness probe (test seam). Defaults to a real single-shot `initialize` round-trip. */
  isAcpReady?: (wsUrl: string) => Promise<boolean>
}

/** E2B's `getHost(port)` returns a host that already encodes the port, so the relay dials `wss://<host>` (TLS/443). */
const wsUrlFor = (sandbox: E2bSandbox): string => `wss://${sandbox.getHost(acpPort)}`

/**
 * Provision a fresh OpenClaw sandbox for `userId`. Stamps the owner into
 * metadata and kicks off the stack, then returns immediately — it does NOT wait
 * for ACP to come up (that ~15-30s boot is observed via {@link openclawSandboxStatusForUser},
 * so the client persists the agent up front and the status badge tracks readiness).
 * Tears the sandbox down if the create/launch itself fails.
 */
export const deployOpenclawSandbox = async (
  userId: string,
  config: OpenclawE2bConfig,
  deps: OpenclawE2bDeps = {},
): Promise<OpenclawSandbox> => {
  const client = deps.client ?? defaultE2bClient
  const envs = {
    OPENROUTER_API_KEY: config.openrouterApiKey,
    MODEL: config.model,
    HOST: '0.0.0.0',
    PORT: String(acpPort),
  }
  const sandbox = await client.create(openclawTemplate, {
    apiKey: config.apiKey,
    timeoutMs: sandboxTimeoutMs,
    // POC posture: the ACP port is publicly reachable (unguessable host) and the
    // Thunderbolt bearer at the relay is the real gate. Hardening later: use the
    // sandbox access token as the upstream credential instead of `secure: false`.
    secure: false,
    metadata: { [ownerMetadataKey]: userId, kind: 'openclaw' },
    envs,
  })
  try {
    await sandbox.commands.run(entrypointCommand, { background: true, envs })
    return { sandboxId: sandbox.sandboxId, wsUrl: wsUrlFor(sandbox) }
  } catch (err) {
    await sandbox.kill().catch(() => {})
    throw err
  }
}

/**
 * Resolve a live, caller-owned sandbox for the relay to dial. Reads the owner
 * from the sandbox's own metadata and returns null unless it matches `userId`,
 * so a forged `?instance=` can never relay into another tenant's sandbox. Null
 * also covers a killed/expired sandbox. Connects only after the ownership check
 * passes.
 */
export const resolveOpenclawSandboxForUser = async (
  sandboxId: string,
  userId: string,
  apiKey: string,
  deps: OpenclawE2bDeps = {},
): Promise<OpenclawSandbox | null> => {
  const client = deps.client ?? defaultE2bClient
  const metadata = await client.getMetadata(sandboxId, { apiKey })
  if (!metadata || metadata[ownerMetadataKey] !== userId) {
    return null
  }
  const sandbox = await client.connect(sandboxId, { apiKey })
  return { sandboxId: sandbox.sandboxId, wsUrl: wsUrlFor(sandbox) }
}

/**
 * Live status of a caller-owned sandbox, for the deploy-status poller. Resolves
 * the sandbox owner-gated, then probes ACP: `gone` if it's been killed/expired or
 * isn't the caller's; `running` once ACP answers; `pending` while it's still
 * booting. The badge poller keeps polling on `pending` and stops on the rest.
 */
export const openclawSandboxStatusForUser = async (
  sandboxId: string,
  userId: string,
  apiKey: string,
  deps: OpenclawE2bDeps = {},
): Promise<OpenclawSandboxStatus> => {
  const sandbox = await resolveOpenclawSandboxForUser(sandboxId, userId, apiKey, deps)
  if (!sandbox) {
    return 'gone'
  }
  const isReady = deps.isAcpReady ?? probeAcpReady
  return (await isReady(sandbox.wsUrl)) ? 'running' : 'pending'
}

/**
 * Trigger teardown of a caller-owned sandbox. Owner-gated exactly like the relay:
 * reads the sandbox's own metadata and kills only when it matches `userId`, so a
 * forged `?instance=` can never kill another tenant's sandbox. A foreign or
 * already-gone sandbox is a no-op (`false`) — undeploy is idempotent, so the
 * client can still drop its local row. Returns once E2B accepts the kill; it does
 * not wait for the microVM to fully tear down.
 */
export const killOpenclawSandboxForUser = async (
  sandboxId: string,
  userId: string,
  apiKey: string,
  deps: OpenclawE2bDeps = {},
): Promise<boolean> => {
  const client = deps.client ?? defaultE2bClient
  const metadata = await client.getMetadata(sandboxId, { apiKey })
  if (!metadata || metadata[ownerMetadataKey] !== userId) {
    return false
  }
  await client.kill(sandboxId, { apiKey })
  return true
}
