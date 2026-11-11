/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it, spyOn } from 'bun:test'
import { prewarmSystemModel } from './prewarm-system-model'
import { useLocalSettingsStore } from '@/stores/local-settings-store'

describe('prewarmSystemModel', () => {
  it('does not contact a server-authenticated client while standalone', async () => {
    const previousCloudUrl = useLocalSettingsStore.getState().cloudUrl
    const fetch = spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Unexpected standalone prewarm'))
    const warn = spyOn(console, 'warn').mockImplementation(() => {})
    useLocalSettingsStore.setState({ cloudUrl: '' })
    try {
      await prewarmSystemModel({ provider: 'tinfoil', isSystem: 1 })
      expect(fetch).not.toHaveBeenCalled()
      expect(warn).not.toHaveBeenCalled()
    } finally {
      useLocalSettingsStore.setState({ cloudUrl: previousCloudUrl })
      fetch.mockRestore()
      warn.mockRestore()
    }
  })

  it.each([
    ['no model', null],
    ['a non-Tinfoil model', { provider: 'openai', isSystem: 1 } as const],
    ['a user Tinfoil model', { provider: 'tinfoil', isSystem: 0 } as const],
  ])('skips warm-up for %s', async (_label, model) => {
    await expect(prewarmSystemModel(model)).resolves.toBeUndefined()
  })
})
