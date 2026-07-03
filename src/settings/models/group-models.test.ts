/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'bun:test'
import type { Model } from '@/types'
import { groupModelsByProvider } from './group-models'

const makeModel = (overrides: Partial<Model>): Model =>
  ({
    id: 'm',
    name: 'M',
    model: 'm',
    provider: 'openai',
    providerId: null,
    enabled: 1,
    isSystem: 0,
    ...overrides,
  }) as Model

describe('groupModelsByProvider', () => {
  it('groups rows carrying a providerId by that connection', () => {
    const models = [
      makeModel({ id: '1', providerId: 'conn-a', model: 'a' }),
      makeModel({ id: '2', providerId: 'conn-a', model: 'b' }),
      makeModel({ id: '3', providerId: 'conn-b', model: 'c' }),
    ]
    const groups = groupModelsByProvider(models)
    expect(groups).toHaveLength(2)
    expect(groups[0]).toMatchObject({ key: 'conn-a', providerId: 'conn-a' })
    expect(groups[0].models.map((m) => m.id)).toEqual(['1', '2'])
    expect(groups[1]).toMatchObject({ key: 'conn-b', providerId: 'conn-b' })
  })

  it('groups system/legacy rows (null providerId) by provider enum', () => {
    const models = [
      makeModel({ id: '1', providerId: null, provider: 'thunderbolt' }),
      makeModel({ id: '2', providerId: null, provider: 'anthropic' }),
      makeModel({ id: '3', providerId: null, provider: 'thunderbolt' }),
    ]
    const groups = groupModelsByProvider(models)
    expect(groups.map((g) => g.key)).toEqual(['type:thunderbolt', 'type:anthropic'])
    expect(groups[0].providerId).toBeNull()
    expect(groups[0].models.map((m) => m.id)).toEqual(['1', '3'])
  })

  it('preserves encounter order across mixed rows', () => {
    const models = [
      makeModel({ id: '1', providerId: null, provider: 'thunderbolt' }),
      makeModel({ id: '2', providerId: 'conn-a' }),
    ]
    expect(groupModelsByProvider(models).map((g) => g.key)).toEqual(['type:thunderbolt', 'conn-a'])
  })
})
