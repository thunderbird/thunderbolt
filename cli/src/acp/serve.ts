/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * `thunderbolt acp serve` — run the built-in coding agent as a stdio ACP
 * JSON-RPC server.
 *
 * stdin/stdout ARE the JSON-RPC channel (newline-delimited JSON), so this path
 * never attaches the terminal renderer and routes every log line to stderr. The
 * intended deployment is behind the iroh/wss bridge, which spawns one
 * `acp serve` process per connection and pumps its stdio over the network:
 *
 *   thunderbolt acp --transport iroh -- thunderbolt acp serve
 *
 * The process lives for exactly one connection; it exits when the stream closes.
 */

import { AgentSideConnection, ndJsonStream } from '@agentclientprotocol/sdk'
import type { CommandSyntaxServeConfig } from '../agent/types.ts'
import { prepareProviderBinding } from '../provider-runtime/provider-stage.ts'
import type { ProviderRuntime } from '../provider-runtime/types.ts'
import { createHarnessAgent } from './harness-agent.ts'
import { createSessionStore, defaultSessionsDir } from './session-store.ts'

/** Adapt this process's stdout to the `WritableStream<Uint8Array>` the ACP
 *  `ndJsonStream` writes encoded messages into, honoring write backpressure via
 *  the write callback so a slow reader throttles us rather than buffering
 *  unboundedly. */
const stdoutWritable = (): WritableStream<Uint8Array> =>
  new WritableStream<Uint8Array>({
    write: (chunk) =>
      new Promise<void>((resolve, reject) => {
        process.stdout.write(chunk, (err) => (err ? reject(err) : resolve()))
      }),
  })

/** Validates and releases one provider binding before the process claims ACP stdio. */
const probeProvider = async (
  config: CommandSyntaxServeConfig,
  runtime: ProviderRuntime,
  signal: AbortSignal,
): Promise<void> => {
  const probe = await prepareProviderBinding(runtime, config.selection, { signal })
  await probe.dispose()
}

/** Owns production stdio only after provider startup validation succeeds. */
const serveStdioConnection = async (config: CommandSyntaxServeConfig, runtime: ProviderRuntime): Promise<void> => {
  const store = createSessionStore(defaultSessionsDir())
  const stream = ndJsonStream(stdoutWritable(), Bun.stdin.stream())
  const connection = new AgentSideConnection((conn) => createHarnessAgent(conn, config, store, runtime), stream)
  await connection.closed
}

/** Runs startup preparation under process cancellation, then hands ownership to the ACP connection signal. */
export const runAcpServe = async (
  config: CommandSyntaxServeConfig,
  runtime: ProviderRuntime,
  {
    serveConnection = serveStdioConnection,
    signal,
  }: {
    readonly serveConnection?: (config: CommandSyntaxServeConfig, runtime: ProviderRuntime) => Promise<void>
    readonly signal?: AbortSignal
  } = {},
): Promise<void> => {
  const controller = new AbortController()
  const abort = (): void => controller.abort()
  const preparationSignal = signal ? AbortSignal.any([controller.signal, signal]) : controller.signal
  process.once('SIGINT', abort)
  process.once('SIGTERM', abort)
  try {
    await probeProvider(config, runtime, preparationSignal)
    preparationSignal.throwIfAborted()
  } finally {
    process.off('SIGINT', abort)
    process.off('SIGTERM', abort)
  }
  await serveConnection(config, runtime)
}
