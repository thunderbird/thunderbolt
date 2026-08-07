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
 * Our own OpenClaw launch, run in place of the image's baked
 * `/opt/docker-entrypoint.sh`. That entrypoint hard-wires OpenRouter (requires
 * `OPENROUTER_API_KEY` and onboards with `--auth-choice openrouter-api-key`), so
 * it can't run on our managed inference. Instead we drive the `openclaw` CLI
 * (already in the image at `~/.openclaw/bin`) to onboard a *custom*
 * OpenAI-compatible provider pointed at `${OPENAI_BASE_URL}` with the
 * per-deployment token as its API key — no provider key ever enters the sandbox.
 * The gateway + ACP↔WS shim start exactly as the baked entrypoint does.
 *
 * `~/.openclaw/bin` is only on PATH via `.bashrc` (not our non-login
 * `commands.run` shell), so the script exports it explicitly.
 */
const openclawLaunchScript = `#!/usr/bin/env bash
set -euo pipefail
export PATH="\${HOME}/.openclaw/bin:\${PATH}"
STATE_DIR="\${HOME}/.openclaw"
PORT="\${PORT:-8790}"

if [ ! -f "\${STATE_DIR}/openclaw.json" ]; then
  openclaw onboard --non-interactive --accept-risk \\
    --auth-choice custom-api-key \\
    --custom-base-url "\${OPENAI_BASE_URL}" \\
    --custom-api-key "\${OPENAI_API_KEY}" \\
    --custom-compatibility openai \\
    --custom-provider-id thunderbolt \\
    --custom-model-id "\${MODEL}" \\
    --skip-channels --skip-daemon --skip-ui --skip-health \\
    --workspace "\${STATE_DIR}/workspace"
fi
openclaw config set agents.defaults.model.primary "thunderbolt/\${MODEL}" >/dev/null 2>&1 || true

openclaw gateway run --auth none --bind loopback --force &
for _ in $(seq 1 60); do
  if (exec 3<>/dev/tcp/127.0.0.1/18789) 2>/dev/null; then exec 3>&- 3<&-; break; fi
  sleep 1
done
exec bun /opt/shim/acp-ws-shim.ts
`

/**
 * Boot command run at deploy. The launch script needs the runtime inference env
 * (base URL + per-deployment token) that isn't known at template-build time, so
 * we ship the script itself base64-encoded (avoids all shell-quoting hazards) and
 * decode+run it with those values in `envs`.
 *
 * A short-lived `sh -c` backgrounds a fully-detached (`setsid nohup … &`) daemon,
 * then exits after a beat. This survives the deploy RPC ending: without `setsid`
 * the script's final `exec bun shim` is the command's foreground process, which
 * E2B tears down when the RPC completes — killing the shim (port 8790) while the
 * backgrounded gateway lingers, so the relay could never reach the sandbox. The
 * trailing `sleep` lets the background stream establish and close cleanly,
 * avoiding an instant-exit "socket closed unexpectedly" from the SDK.
 */
const openclawLaunchScriptB64 = Buffer.from(openclawLaunchScript).toString('base64')
const entrypointCommand = `sh -c 'echo ${openclawLaunchScriptB64} | base64 -d > /tmp/openclaw-launch.sh && setsid nohup bash /tmp/openclaw-launch.sh >/tmp/openclaw-boot.log 2>&1 </dev/null & sleep 2'`
/** Metadata key carrying the owning user's id — the relay's tenant-isolation gate. */
const ownerMetadataKey = 'userId'
/**
 * Hardcoded while E2B is the only sandbox backend. When the sandbox-provider seam
 * lands this becomes per-provider config (template id) rather than a constant here.
 */
const openclawTemplate = 'thunderbolt-openclaw'
/**
 * Idle window before E2B auto-pauses the sandbox. The sandbox is created with
 * `lifecycle: { onTimeout: 'pause', autoResume: true }`, so hitting this timeout
 * PAUSES (full memory snapshot) instead of killing; the next inbound connection
 * transparently resumes it. The relay bumps this on activity (see
 * {@link extendOpenclawSandboxTimeout}) so an in-use chat never pauses mid-turn.
 */
const idleTimeoutMs = 15 * 60 * 1000

/** A provisioned OpenClaw sandbox (backend-side). `wsUrl` is the in-sandbox ACP endpoint the relay dials. */
export type OpenclawSandbox = { sandboxId: string; wsUrl: string }

/**
 * Everything a deploy needs, mapped from settings at the call site so this module
 * stays settings-agnostic. The sandbox runs on OUR managed inference: `publicApiUrl`
 * is the externally-resolvable backend origin it dials, `model` is the managed
 * model id the deploy targets (e.g. `opus-4.8`).
 */
export type OpenclawE2bConfig = {
  apiKey: string
  publicApiUrl: string
  model: string
}

/**
 * Deploy-time hooks the provider supplies so this module stays free of the DB and
 * token-minting concerns. Both are keyed off the freshly-created `sandboxId`
 * (which the deployment id encodes), resolving the chicken-and-egg where the token
 * must name the deployment it authorizes.
 */
export type OpenclawDeployHooks = {
  /** Persist the deployment record so its inference token is accepted. Runs before the stack boots. */
  recordDeployment: (sandboxId: string) => Promise<void>
  /** Mint the scoped, non-expiring inference token the sandbox uses as its `OPENAI_API_KEY`. */
  mintToken: (sandboxId: string) => Promise<string>
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
      /** When true, the sandbox auto-pauses (memory snapshot) on timeout and auto-resumes on traffic. */
      autoPause: boolean
    },
  ) => Promise<E2bSandbox>
  connect: (sandboxId: string, opts: { apiKey: string }) => Promise<E2bSandbox>
  /** The sandbox's saved metadata, or null if it no longer exists (killed/expired). */
  getMetadata: (sandboxId: string, opts: { apiKey: string }) => Promise<Record<string, string> | null>
  kill: (sandboxId: string, opts: { apiKey: string }) => Promise<void>
  /** Extend (or reduce) the sandbox's idle-pause timeout — used to keep an active chat alive. */
  setTimeout: (sandboxId: string, timeoutMs: number, opts: { apiKey: string }) => Promise<void>
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
        // Auto-pause with a full memory snapshot + auto-resume on inbound traffic.
        // `Sandbox.connect`/dialing the host wakes it transparently, and because
        // this lifecycle is stored server-side (connect does NOT reset it) the
        // resumed sandbox keeps auto-pausing on each subsequent idle window.
        ...(opts.autoPause ? { lifecycle: { onTimeout: 'pause' as const, autoResume: true } } : {}),
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
  setTimeout: async (sandboxId, timeoutMs, opts) => {
    await Sandbox.setTimeout(sandboxId, timeoutMs, { apiKey: opts.apiKey })
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
 * Provision a fresh OpenClaw sandbox for `userId`, wired to our managed inference.
 *
 * Ordering resolves the chicken-and-egg (the token must name the deployment,
 * whose id encodes the sandbox id): create the sandbox → record the deployment →
 * mint the scoped token → launch the stack with the token in `envs`. The launch
 * onboards OpenClaw's custom OpenAI-compatible provider against `${publicApiUrl}/v1`
 * with that token as its API key (see {@link openclawLaunchScript}). No provider
 * key ever enters the sandbox.
 *
 * Returns immediately — it does NOT wait for ACP to come up (that ~15-30s boot is
 * observed via {@link openclawSandboxStatusForUser}, so the client persists the
 * agent up front and the status badge tracks readiness). Tears the sandbox down
 * if anything after create fails (record / mint / launch), so a failed deploy
 * never leaks a running microVM.
 */
export const deployOpenclawSandbox = async (
  userId: string,
  config: OpenclawE2bConfig,
  hooks: OpenclawDeployHooks,
  deps: OpenclawE2bDeps = {},
): Promise<OpenclawSandbox> => {
  const client = deps.client ?? defaultE2bClient
  const baseEnvs = {
    OPENAI_BASE_URL: `${config.publicApiUrl}/v1`,
    MODEL: config.model,
    PORT: String(acpPort),
  }
  const sandbox = await client.create(openclawTemplate, {
    apiKey: config.apiKey,
    timeoutMs: idleTimeoutMs,
    // POC posture: the ACP port is publicly reachable (unguessable host) and the
    // Thunderbolt bearer at the relay is the real gate. Hardening later: use the
    // sandbox access token as the upstream credential instead of `secure: false`.
    secure: false,
    metadata: { [ownerMetadataKey]: userId, kind: 'openclaw' },
    envs: baseEnvs,
    autoPause: true,
  })
  try {
    await hooks.recordDeployment(sandbox.sandboxId)
    const token = await hooks.mintToken(sandbox.sandboxId)
    const envs = { ...baseEnvs, OPENAI_API_KEY: token }
    await sandbox.commands.run(entrypointCommand, { background: true, envs })
    return { sandboxId: sandbox.sandboxId, wsUrl: wsUrlFor(sandbox) }
  } catch (err) {
    await sandbox.kill().catch(() => {})
    throw err
  }
}

/**
 * Push the sandbox's idle-pause timeout back out to {@link idleTimeoutMs} so an
 * active chat never pauses mid-session. Best-effort: a failed extend is swallowed
 * (a transient E2B hiccup must never drop the live relay). Not owner-gated — the
 * relay only ever calls this for a sandbox it has already resolved owner-gated.
 */
export const extendOpenclawSandboxTimeout = async (
  sandboxId: string,
  apiKey: string,
  deps: OpenclawE2bDeps = {},
): Promise<void> => {
  const client = deps.client ?? defaultE2bClient
  await client.setTimeout(sandboxId, idleTimeoutMs, { apiKey }).catch(() => {})
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
