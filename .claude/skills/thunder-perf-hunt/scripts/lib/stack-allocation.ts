/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** Reserve distinct listening ports and a private database directory for one run. */
export const allocateStack = async () => {
  const reservePort = () => Bun.listen({ hostname: '127.0.0.1', port: 0, socket: { data: () => {} } })
  const reservations = new Set<ReturnType<typeof reservePort>>()
  const release = (listener: ReturnType<typeof reservePort>) => {
    if (reservations.delete(listener)) listener.stop()
  }
  try {
    const backend = reservePort()
    reservations.add(backend)
    const frontend = reservePort()
    reservations.add(frontend)
    const databaseDir = await mkdtemp(join(tmpdir(), 'thunder-perf-hunt-'))
    return {
      backendPort: backend.port,
      frontendPort: frontend.port,
      backendUrl: `http://127.0.0.1:${backend.port}`,
      baseUrl: `http://127.0.0.1:${frontend.port}`,
      databaseDir,
      releaseBackendPort: () => release(backend),
      releaseFrontendPort: () => release(frontend),
      cleanup: async () => {
        for (const listener of reservations) release(listener)
        await rm(databaseDir, { recursive: true, force: true })
      },
    }
  } catch (error) {
    for (const listener of reservations) release(listener)
    throw error
  }
}

export type StackAllocation = Awaited<ReturnType<typeof allocateStack>>
