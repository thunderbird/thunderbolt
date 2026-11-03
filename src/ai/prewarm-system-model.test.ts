/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { afterEach, describe, expect, it, mock, spyOn } from 'bun:test'
import { prewarmSystemModel } from './prewarm-system-model'
import { useLocalSettingsStore } from '@/stores/local-settings-store'

const systemModel = { provider: 'tinfoil', isSystem: 1 } as const

describe('prewarmSystemModel', () => {
  it('does not load a server-authenticated client while standalone', async () => {
    useLocalSettingsStore.setState({ cloudUrl: '' })
    const loadPrewarm = mock(async () => async () => {})
    await prewarmSystemModel(systemModel, loadPrewarm)
    expect(loadPrewarm).not.toHaveBeenCalled()
  })

  afterEach(() => {
    mock.restore()
  })

  it('warms the system client through the lazily loaded chunk', async () => {
    const runSystemModelPrewarm = mock(async () => {})

    await prewarmSystemModel(systemModel, async () => runSystemModelPrewarm)

    expect(runSystemModelPrewarm).toHaveBeenCalledWith(systemModel)
  })

  it('resolves and warns when the chunk fails to load', async () => {
    const warn = spyOn(console, 'warn').mockImplementation(() => {})
    const loadFailure = new TypeError('Importing a module script failed.')

    await expect(prewarmSystemModel(systemModel, () => Promise.reject(loadFailure))).resolves.toBeUndefined()

    expect(warn).toHaveBeenCalledWith(expect.any(String), loadFailure)
  })

  it.each([
    ['no model', null],
    ['a non-Tinfoil model', { provider: 'openai', isSystem: 1 } as const],
    ['a user Tinfoil model', { provider: 'tinfoil', isSystem: 0 } as const],
  ])('does not load the chunk for %s', async (_label, model) => {
    const loadPrewarm = mock(async () => async () => {})

    await prewarmSystemModel(model, loadPrewarm)

    expect(loadPrewarm).not.toHaveBeenCalled()
  })
})
