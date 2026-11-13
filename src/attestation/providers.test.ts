/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { afterEach, expect, it, mock, spyOn } from 'bun:test'
import * as clients from '@/ai/privatemode-client'
import * as connections from '@/providers/model-connection'
import { createMockModel } from '@/test-utils/chat-store-mocks'
import { verifyAttestedModel } from './providers'

afterEach(() => mock.restore())

/** Exercise a connection changing while its SDK is still verifying. */
const setup = () => {
  const model = createMockModel({ provider: 'privatemode', providerConnectionId: 'connection', apiKey: 'old-key' })
  const assertCurrent = mock(async () => {})
  spyOn(connections, 'bindModelProvider').mockResolvedValue({
    model: { ...model, apiKey: 'current-key' },
    wrapFetch: (fetch) => fetch,
    assertCurrent,
  })
  const client = {
    baseURL: 'https://api.privatemode.ai/v1',
    fetch: mock(async () => new Response('')),
    close: mock(async () => {}),
    ensureVerified: mock(async () => {}),
  }
  const acquire = spyOn(clients, 'getPrivatemodeClient').mockResolvedValue(client)
  const evict = spyOn(clients, 'evictPrivatemodeClient').mockImplementation(() => {})
  return { model, assertCurrent, client, acquire, evict }
}

it('retires only the acquired client if its credential binding changes during verification', async () => {
  const { model, assertCurrent, client, acquire, evict } = setup()
  const error = new Error('provider connection changed')
  assertCurrent.mockRejectedValue(error)
  await expect(verifyAttestedModel(model)).rejects.toBe(error)
  expect(acquire).toHaveBeenCalledWith({ connectionId: 'connection', apiKey: 'current-key' })
  expect(evict).toHaveBeenCalledWith('connection', client)
})

it('retains a verified client when its credential binding is still current', async () => {
  const { model, assertCurrent, evict } = setup()
  await verifyAttestedModel(model)
  expect(assertCurrent).toHaveBeenCalledTimes(1)
  expect(evict).not.toHaveBeenCalled()
})
