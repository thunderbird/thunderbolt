/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useConfigStore } from '@/api/config-store'
import { afterEach, describe, expect, it } from 'bun:test'
import { builtInAgent } from './agents'

describe('builtInAgent', () => {
  afterEach(() => {
    useConfigStore.setState({ config: {} })
  })

  it('carries the current app name, so a held reference follows a rename', () => {
    const held = builtInAgent
    expect(held.name).toBe('Thunderbolt')

    useConfigStore.setState({ config: { branding: { appName: 'Acme AI' } } })
    expect(held.name).toBe('Acme AI')
  })
})
