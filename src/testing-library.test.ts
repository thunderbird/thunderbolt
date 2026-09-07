/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useConfigStore } from '@/api/config-store'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'

describe('global config store isolation', () => {
  beforeAll(() => {
    useConfigStore.getState().updateConfig({ e2eeEnabled: true })
    useConfigStore.getState().setForceUpgrade('5.0.0')
  })

  afterAll(() => {
    useConfigStore.setState({ config: {}, forceUpgrade: undefined, forceUpgradeMinVersion: undefined })
  })

  it('clears inherited config and transient upgrade state before each test', () => {
    const { config, forceUpgrade, forceUpgradeMinVersion } = useConfigStore.getState()
    expect({ config, forceUpgrade, forceUpgradeMinVersion }).toEqual({
      config: {},
      forceUpgrade: undefined,
      forceUpgradeMinVersion: undefined,
    })
  })
})
