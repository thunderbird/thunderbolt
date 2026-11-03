/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'bun:test'
import { mergeLocalSettings, useLocalSettingsStore } from './local-settings-store'

const localDefaults = () => ({
  ...useLocalSettingsStore.getState(),
  cloudUrl: '',
  localMode: true,
  serverHasAuthenticated: false,
})

describe('local settings hydration', () => {
  it('keeps fresh standalone installs unbound', () => {
    expect(mergeLocalSettings(undefined, localDefaults())).toMatchObject({
      cloudUrl: '',
      localMode: true,
      serverHasAuthenticated: false,
    })
  })

  it('keeps legacy configured installations account-bound even on a new native default', () => {
    expect(mergeLocalSettings({ cloudUrl: 'https://existing.example/v1' }, localDefaults())).toMatchObject({
      cloudUrl: 'https://existing.example/v1',
      localMode: false,
      serverHasAuthenticated: true,
    })
  })

  it('preserves an explicitly unclaimed server and local access across restarts', () => {
    const saved = { cloudUrl: 'https://selected.example/v1', localMode: true, serverHasAuthenticated: false }
    expect(mergeLocalSettings(saved, localDefaults())).toMatchObject(saved)
  })
})
