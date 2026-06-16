/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'bun:test'
import { getDbFilenameFor } from './database-path'
import { serverIdFromWorkerName, workerNameFor } from './sync-worker-name'

describe('sync-worker-name', () => {
  describe('round-trip with getDbFilenameFor', () => {
    it('server trust domain: workerNameFor → serverIdFromWorkerName recovers the serverId', () => {
      const serverId = '11111111-2222-3333-4444-555555555555'
      const dbFilename = getDbFilenameFor({ kind: 'server', serverId })
      const workerName = workerNameFor(dbFilename)

      expect(workerName).toBe('shared-sync-server-11111111-2222-3333-4444-555555555555.db')
      expect(serverIdFromWorkerName(workerName)).toBe(serverId)
    })

    it('standalone trust domain: workerNameFor produces a non-server name (no recoverable serverId)', () => {
      const dbFilename = getDbFilenameFor({ kind: 'standalone' })
      const workerName = workerNameFor(dbFilename)

      expect(workerName).toBe('shared-sync-standalone.db')
      expect(serverIdFromWorkerName(workerName)).toBeUndefined()
    })
  })

  describe('serverIdFromWorkerName edge cases', () => {
    it('returns undefined for an empty string', () => {
      expect(serverIdFromWorkerName('')).toBeUndefined()
    })

    it('returns undefined for undefined', () => {
      expect(serverIdFromWorkerName(undefined)).toBeUndefined()
    })

    it('returns undefined for an unrelated worker name', () => {
      expect(serverIdFromWorkerName('some-other-worker')).toBeUndefined()
    })
  })
})
