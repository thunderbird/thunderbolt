/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Client side of the iroh transport: dial a remote bridge and pump a local
 * stdio ACP/MCP client into it. The mirror image of {@link runIrohBridge} —
 * the same ndjson byte pump, just sourced from this side's stdio (or a spawned
 * local client) instead of a server-spawned agent.
 *
 * With `-- <cmd>` it spawns that local client and bridges its stdio; without a
 * command it bridges this process's own stdin/stdout, so a JSON-RPC line can be
 * piped straight through to prove the round-trip. A bidi stream erroring as the
 * connection closes is the normal end-of-pipe, so the pumps settle rather than
 * throw; the caller decides success from whether any bytes came back.
 */

import type { Connection } from '@number0/iroh'
import type { ConnectConfig } from '../agent/types.ts'
import { spawnAgent } from '../commands/bridge.ts'
import { dial } from './endpoint.ts'
import { forwardFromRecv, forwardToSend, writeToStdin } from './pump.ts'

/** Write received bytes to this process's stdout, awaiting a `drain` when the
 *  kernel buffer is full so the iroh read loop respects stdout backpressure. An
 *  `EPIPE` (the downstream of a pipe like `| head` closed early) is logged
 *  loudly and rethrown so the pump stops rather than swallowing the failure. */
const writeToStdout = (chunk: Uint8Array): Promise<void> =>
  new Promise<void>((resolve, reject) => {
    const onError = (err: Error): void => {
      process.stderr.write(`⚡ iroh connect: stdout write failed: ${err.message}\n`)
      reject(err)
    }
    if (process.stdout.write(chunk, (err) => err && onError(err))) {
      resolve()
    } else {
      process.stdout.once('drain', resolve)
    }
  })

/** Wait until the pumps settle *or* the connection closes — whichever first —
 *  so a peer that refuses us mid-pump is observed (and its close reason is
 *  populated) rather than leaving us blocked on a half that will never end. */
const settleOrClose = (connection: Connection, pumps: Promise<unknown>[]): Promise<unknown> =>
  Promise.race([Promise.allSettled(pumps), connection.closed()])

/** Pump a spawned local client's stdio over the connection's bidi stream,
 *  returning the number of bytes received back from the remote agent. */
const bridgeLocalCommand = async (connection: Connection, command: readonly string[]): Promise<number> => {
  const proc = spawnAgent(command)
  if (!proc) throw new Error(`failed to spawn local client '${command[0]}'`)
  void connection.closed().then(() => proc.kill())

  let received = 0
  const bi = await connection.openBi()
  const toRemote = forwardToSend(proc.stdout, bi.send)
  // `.finally` so the local client always gets stdin EOF, even on a torn stream.
  const fromRemote = forwardFromRecv(bi.recv, (chunk) => {
    received += chunk.length
    return writeToStdin(proc.stdin, chunk, 'connect')
  }).finally(() => proc.stdin.end())
  await settleOrClose(connection, [toRemote, fromRemote])
  return received
}

/** Pump this process's own stdin/stdout over the connection's bidi stream,
 *  returning the number of bytes received back from the remote agent. */
const bridgeProcessStdio = async (connection: Connection): Promise<number> => {
  let received = 0
  const bi = await connection.openBi()
  const toRemote = forwardToSend(Bun.stdin.stream(), bi.send)
  const fromRemote = forwardFromRecv(bi.recv, (chunk) => {
    received += chunk.length
    return writeToStdout(chunk)
  })
  await settleOrClose(connection, [toRemote, fromRemote])
  return received
}

/**
 * Decide whether a finished connect attempt was a refusal / dead end. The remote
 * rejects a non-allowlisted peer by closing before any data flows, so "zero bytes
 * back *and* an explicit signal (a local pump failure or a peer close reason)" is
 * the refusal fingerprint. The peer's close `reason` is preferred over our local
 * failure message because it names *why* the remote hung up. Zero bytes with no
 * signal at all is not treated as an error (a clean, empty round-trip).
 *
 * @param received - bytes received back from the remote
 * @param failure - a local pump error, or `null` if the pumps settled cleanly
 * @param reason - the peer-supplied close reason, or `null` if none
 */
export const refusalError = (received: number, failure: unknown, reason: string | null): Error | null => {
  if (received !== 0 || (failure === null && reason === null)) return null
  const detail = reason ?? (failure instanceof Error ? failure.message : String(failure))
  return new Error(`iroh connect: refused or no response from remote (${detail})`)
}

/**
 * Dial the remote bridge identified by `config.target` and bridge a local
 * client to it. If the remote rejects this node (not allowlisted) it closes the
 * connection before any data flows; with no bytes received and a peer-supplied
 * close reason, that surfaces here as a clear, non-zero-exit error.
 */
export const runIrohConnect = async (config: ConnectConfig): Promise<void> => {
  const { endpoint, connection } = await dial(config.target, config.protocol)

  let received = 0
  let failure: unknown = null
  try {
    received =
      config.command.length > 0
        ? await bridgeLocalCommand(connection, config.command)
        : await bridgeProcessStdio(connection)
  } catch (err) {
    failure = err
  }

  // Capture the peer's close reason before tearing down our endpoint, which
  // would otherwise overwrite it with our own local close.
  const reason = connection.closeReason()
  await endpoint.close()

  const refusal = refusalError(received, failure, reason)
  if (refusal) throw refusal
}
