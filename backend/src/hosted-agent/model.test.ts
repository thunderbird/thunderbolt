/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'bun:test'
import { getAgentIdentity } from './model'

describe('getAgentIdentity', () => {
  it.each(['accounts/fireworks/models/glm-5p3', 'accounts/fireworks/models/minimax-m3'])(
    'serves %s from Fireworks under its full id',
    (model) => {
      expect(getAgentIdentity(model)).toEqual({ provider: 'fireworks', model })
    },
  )

  it.each([
    'claude-opus-5-5',
    'glm-5p3',
    'fireworks/glm-5p3',
    'accounts/acme/models/glm-5p3',
    'x-accounts/fireworks/models/glm-5p3',
  ])('serves %s from Anthropic', (model) => {
    expect(getAgentIdentity(model)).toEqual({ provider: 'anthropic', model })
  })
})
