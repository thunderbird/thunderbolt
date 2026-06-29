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
import type { ServeConfig } from '../agent/types.ts'
import { createHarnessAgent } from './harness-agent.ts'

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

/**
 * Serve the built-in harness as an ACP agent over stdio until the client
 * disconnects (the stream closes). Returns when the connection is fully closed.
 *
 * @param config - the resolved serve configuration (model, thinking, yolo)
 */
export const runAcpServe = async (config: ServeConfig): Promise<void> => {
  const stream = ndJsonStream(stdoutWritable(), Bun.stdin.stream())
  const connection = new AgentSideConnection((conn) => createHarnessAgent(conn, config), stream)
  await connection.closed
}
