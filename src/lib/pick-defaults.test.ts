/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, test } from 'bun:test'
import { defaultModelOpus48, defaultModels, defaultModelsVersion } from '@shared/defaults/models'
import { pickModelsDefaults } from './pick-defaults'

const serverPayload = (version: number) => ({
  version,
  data: [{ ...defaultModelOpus48, name: `Server v${version}` }],
})

describe('pickModelsDefaults', () => {
  test('bundle wins when server is absent (offline / no fetch yet)', () => {
    const picked = pickModelsDefaults(undefined)
    expect(picked.version).toBe(defaultModelsVersion)
    expect(picked.data).toBe(defaultModels)
  })

  test('server wins when it declares a strictly higher version', () => {
    const server = serverPayload(defaultModelsVersion + 1)
    const picked = pickModelsDefaults(server)
    expect(picked.version).toBe(server.version)
    expect(picked.data).toBe(server.data)
  })

  test('bundle wins when server declares an equal version (avoid needless swap)', () => {
    const picked = pickModelsDefaults(serverPayload(defaultModelsVersion))
    expect(picked.version).toBe(defaultModelsVersion)
    expect(picked.data).toBe(defaultModels)
  })

  test('bundle wins when server declares a lower version (rollback protection)', () => {
    const picked = pickModelsDefaults(serverPayload(defaultModelsVersion - 1))
    expect(picked.version).toBe(defaultModelsVersion)
    expect(picked.data).toBe(defaultModels)
  })
})
