/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Entry point: load config, build the session registry, start the server, and
 * run the two sweepers — a fast one disposing idle in-memory runtimes, and a
 * slow one erasing on-disk sessions past the retention window (measured in
 * days, so an hourly cadence is ample and keeps the scan off the hot path).
 * SIGTERM/SIGINT stop accepting work and dispose live runtimes (disk session
 * logs survive for resume). Sessions are owned by this process, so a deployment
 * ends every in-flight turn — clients resume and re-prompt. See `README.md`.
 */

import { loadConfig } from './config.ts'
import { startServer } from './server.ts'
import { createSessionRegistry } from './session-runtime.ts'

const idleSweepIntervalMs = 60_000
const retentionSweepIntervalMs = 60 * 60 * 1000

const config = loadConfig()
const registry = createSessionRegistry(config)
const { server, stop } = startServer(config, registry)

const sweepers = [
  setInterval(() => {
    void registry.sweep(config.idleSessionTtlMs)
  }, idleSweepIntervalMs),
  setInterval(() => {
    void registry.purgeExpired(config.retentionMs)
  }, retentionSweepIntervalMs),
]

const shutdown = (): void => {
  for (const sweeper of sweepers) {
    clearInterval(sweeper)
  }
  stop()
  void registry.disposeAll().finally(() => process.exit(0))
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)

process.stdout.write(
  `⚡ thunderbolt runner listening on :${server.port}\n` +
    `   backend: ${config.backendUrl} (bearer introspection + inference gateway)\n` +
    `   data dir: ${config.dataDir}\n`,
)
