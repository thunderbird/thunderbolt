/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'bun:test'
import { getAgentIdentity } from './model'

describe('getAgentIdentity', () => {
  it.each([
    ['accounts/fireworks/models/glm-5p3', 'fireworks'],
    ['accounts/fireworks/models/minimax-m3', 'fireworks'],
    ['claude-opus-5-5', 'anthropic'],
  ] as const)('runs %s on %s', (model, provider) => {
    expect(getAgentIdentity(model)).toEqual({ provider, model })
  })

  it('names the id, both supported shapes and the supported ids when it refuses', () => {
    expect(() => getAgentIdentity('accounts/acme/models/glm-5p3')).toThrow(
      'AGENT_MODEL "accounts/acme/models/glm-5p3" is not a hosted-agent model. Use a Fireworks serverless id ' +
        '(accounts/fireworks/models/<name>) or a bare Anthropic id, one of: accounts/fireworks/models/glm-5p3, ' +
        'accounts/fireworks/models/minimax-m3, claude-opus-5-5. Fireworks models in other accounts are not supported yet.',
    )
  })
})
