/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { powersyncTableNames } from './powersync-tables'

describe('provider connection sync rollout', () => {
  it.each([
    '../powersync-service/config/config.yaml',
    '../deploy/config/powersync-config.yaml',
    '../deploy/k8s/templates/configmaps.yaml',
  ])('gates metadata by account and device revocation in %s', (path) => {
    const config = readFileSync(new URL(path, import.meta.url), 'utf8')
    const essentials = config.slice(config.indexOf('user_essentials:'), config.indexOf('user_data:'))
    expect(essentials).toContain(
      "SELECT * FROM powersync.provider_connections WHERE user_id IN active_device_account OR (user_id = auth.user_id() AND auth.parameter('device_id') IS NULL)",
    )
    expect(config).not.toContain('provider_connection_secrets')
    expect(powersyncTableNames).toContain('provider_connections')
  })
})
