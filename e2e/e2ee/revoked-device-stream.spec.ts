/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Requires the PowerSync + Postgres harness. Run with:
 *   bash scripts/run-e2ee-powersync.sh
 */

import { sql, waitForConsumedChallenge, waitForDeviceState, waitForUserId } from './db'
import { expect, test } from './fixtures'
import {
  completeFirstDeviceSetup,
  createE2eeEmail,
  loginViaConsumerOtp,
  revokeTrustedDevice,
  trustAdditionalDevice,
} from './helpers'
import type { Page } from '@playwright/test'

type SyncToken = { token: string; powerSyncUrl: string }

type SyncOp = { object_type: string; object_id: string; data: string | null }

type SyncLine = {
  checkpoint?: { buckets: Array<{ bucket: string }> }
  checkpoint_diff?: { removed_buckets: string[] }
  checkpoint_complete?: unknown
  data?: { bucket: string; data: SyncOp[] }
}

type SyncStream = { lines: SyncLine[]; close: () => void }

/** The sync token the app itself fetches on its next connect. */
const captureSyncToken = async (page: Page): Promise<SyncToken> => {
  const [response] = await Promise.all([
    page.waitForResponse((response) => response.url().endsWith('/powersync/token') && response.ok()),
    page.reload(),
  ])
  return (await response.json()) as SyncToken
}

/** Hold a raw sync stream open on `token`, the way a client that kept its JWT would. */
const openSyncStream = ({ token, powerSyncUrl }: SyncToken): SyncStream => {
  const lines: SyncLine[] = []
  const controller = new AbortController()
  const read = async () => {
    const response = await fetch(`${powerSyncUrl}/sync/stream`, {
      method: 'POST',
      headers: { Authorization: `Token ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ buckets: [], include_checksum: true, raw_data: true, client_id: crypto.randomUUID() }),
      signal: controller.signal,
    })
    const reader = response.body!.pipeThrough(new TextDecoderStream()).getReader()
    let pending = ''
    for (;;) {
      const { value, done } = await reader.read()
      if (done) {
        return
      }
      const parts = (pending + value).split('\n')
      pending = parts.pop() ?? ''
      lines.push(...parts.filter((part) => part.trim()).map((part) => JSON.parse(part) as SyncLine))
    }
  }
  read().catch(() => {})
  return { lines, close: () => controller.abort() }
}

const hasCompletedCheckpoint = (stream: SyncStream) => stream.lines.some((line) => line.checkpoint_complete)

const accountBuckets = (stream: SyncStream) =>
  (stream.lines.find((line) => line.checkpoint)?.checkpoint?.buckets ?? [])
    .map(({ bucket }) => bucket)
    .filter((bucket) => !bucket.includes('#device_self|'))
    .sort()

const removedBuckets = (stream: SyncStream) =>
  stream.lines.flatMap((line) => line.checkpoint_diff?.removed_buckets ?? []).sort()

const carriesRow = (stream: SyncStream, rowId: string) =>
  stream.lines.some((line) => line.data?.data.some((op) => op.object_id === rowId))

const ownRowIsRevoked = (stream: SyncStream, deviceId: string) =>
  stream.lines.some(
    (line) =>
      line.data?.bucket.includes('#device_self|') &&
      line.data.data.some(
        (op) => op.object_id === deviceId && op.data !== null && JSON.parse(op.data).revoked_at !== null,
      ),
  )

test.describe('revoked device sync stream', () => {
  test('an open stream loses the account buckets on revocation, before its token expires', async ({
    browser,
    page,
  }) => {
    const email = createE2eeEmail()
    await loginViaConsumerOtp(page, email)
    const userId = await waitForUserId(email)
    await completeFirstDeviceSetup(page)

    const device = await trustAdditionalDevice(browser, page, { email, userId, profile: 'firefox' })
    const ownerToken = await captureSyncToken(page)
    const revokedToken = await captureSyncToken(device.page)
    // The test holds the device's token itself, so the app's own wipe can't mask a stream that stays open.
    await device.context.close()

    const ownerStream = openSyncStream(ownerToken)
    const revokedStream = openSyncStream(revokedToken)
    try {
      await expect.poll(() => hasCompletedCheckpoint(revokedStream), { timeout: 60_000 }).toBe(true)
      await expect.poll(() => hasCompletedCheckpoint(ownerStream), { timeout: 60_000 }).toBe(true)
      // Non-vacuity: before revocation the stream carries both account buckets.
      const buckets = accountBuckets(revokedStream)
      expect(buckets).toEqual([expect.stringContaining('#user_data|'), expect.stringContaining('#user_essentials|')])

      await revokeTrustedDevice(page, device.label)
      await waitForConsumedChallenge(userId, 'revoke')
      await waitForDeviceState(userId, device.deviceId, (state) => state.revokedAt !== null)

      await expect.poll(() => removedBuckets(revokedStream), { timeout: 30_000 }).toEqual(buckets)
      await expect.poll(() => ownRowIsRevoked(revokedStream, device.deviceId), { timeout: 30_000 }).toBe(true)

      // A later write to each account bucket reaches the owner's stream but not the revoked one.
      const threadId = crypto.randomUUID()
      const taskId = crypto.randomUUID()
      await sql`INSERT INTO powersync.chat_threads (id, user_id, title) VALUES (${threadId}, ${userId}, 'after revocation')`
      await sql`INSERT INTO powersync.tasks (id, user_id, item) VALUES (${taskId}, ${userId}, 'after revocation')`
      await expect
        .poll(() => carriesRow(ownerStream, threadId) && carriesRow(ownerStream, taskId), { timeout: 30_000 })
        .toBe(true)
      expect(carriesRow(revokedStream, threadId)).toBe(false)
      expect(carriesRow(revokedStream, taskId)).toBe(false)
    } finally {
      ownerStream.close()
      revokedStream.close()
    }
  })
})
