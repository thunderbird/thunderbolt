/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { afterEach, describe, expect, it, mock, spyOn } from 'bun:test'
import { prewarmTinfoilModel } from './prewarm-tinfoil-model'
import { useLocalSettingsStore } from '@/stores/local-settings-store'

const systemModel = { provider: 'tinfoil', isSystem: 1 } as const

/** Isolate the public attestation acquisition boundary; no provider credentials are needed to verify an enclave. */
const setup = () => {
  const clients = {
    getSystemTinfoilClient: mock(async () => {}),
    getTinfoilClient: mock(async () => {}),
  }
  return { ...clients, loadClients: mock(async () => clients) }
}

afterEach(() => mock.restore())

describe('prewarmTinfoilModel', () => {
  it('warms the managed client through the lazily loaded chunk', async () => {
    const clients = setup()
    await prewarmTinfoilModel(systemModel, clients.loadClients)
    expect(clients.getSystemTinfoilClient).toHaveBeenCalledTimes(1)
    expect(clients.getTinfoilClient).not.toHaveBeenCalled()
  })

  it.each([{ apiKey: 'model-key' }, { apiKey: null, providerConnectionId: 'connection', oauthProvider: 'tinfoil' }])(
    'warms direct Tinfoil in standalone mode with model or connection credentials: %j',
    async (credentials) => {
      useLocalSettingsStore.setState({ cloudUrl: '', localMode: true })
      const clients = setup()
      const model = { ...systemModel, isSystem: 0, ...credentials }
      await prewarmTinfoilModel(model, clients.loadClients)
      expect(clients.getTinfoilClient).toHaveBeenCalledTimes(1)
      expect(clients.getSystemTinfoilClient).not.toHaveBeenCalled()
    },
  )

  it('does not load a managed client while standalone', async () => {
    useLocalSettingsStore.setState({ cloudUrl: '', localMode: true })
    const clients = setup()
    await prewarmTinfoilModel(systemModel, clients.loadClients)
    expect(clients.loadClients).not.toHaveBeenCalled()
  })

  it.each([
    ['no model', null],
    ['a non-Tinfoil model', { provider: 'openai', isSystem: 1 } as const],
  ])('does not load the chunk for %s', async (_label, model) => {
    const clients = setup()
    await prewarmTinfoilModel(model, clients.loadClients)
    expect(clients.loadClients).not.toHaveBeenCalled()
  })

  it('handles a failed chunk load without blocking chat', async () => {
    const warn = spyOn(console, 'warn').mockImplementation(() => {})
    const failure = new TypeError('Importing a module script failed.')
    await expect(prewarmTinfoilModel(systemModel, () => Promise.reject(failure))).resolves.toBeUndefined()
    expect(warn).toHaveBeenCalledWith(expect.any(String), failure)
  })

  it.each([0, 1])('handles failed verification without blocking chat (isSystem=%s)', async (isSystem) => {
    const warn = spyOn(console, 'warn').mockImplementation(() => {})
    const clients = setup()
    const failure = new Error('Attestation failed')
    const acquire = isSystem ? clients.getSystemTinfoilClient : clients.getTinfoilClient
    acquire.mockRejectedValue(failure)
    await expect(prewarmTinfoilModel({ ...systemModel, isSystem }, clients.loadClients)).resolves.toBeUndefined()
    expect(warn).toHaveBeenCalledWith(expect.any(String), failure)
  })
})
