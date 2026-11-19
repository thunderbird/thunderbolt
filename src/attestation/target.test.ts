/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'bun:test'
import { builtInAgent } from '@/defaults/agents'
import { resolveAttestationTarget } from './target'

const model = { provider: 'tinfoil', isSystem: 1, isConfidential: 1 } as const

describe('attestation target', () => {
  it.each(['remote-acp', 'managed-acp', 'managed-http'] as const)(
    'never attributes a local Tinfoil attestation to a %s agent',
    (type) => {
      expect(resolveAttestationTarget({ id: 'remote', name: 'My agent', type }, model, 'https://cloud/v1')).toEqual({
        kind: 'agent',
        key: 'agent:remote',
        name: 'My agent',
      })
    },
  )

  it('scopes managed evidence by backend URL and keeps BYOK separate', () => {
    expect(resolveAttestationTarget(builtInAgent, model, 'https://one/v1/')).toMatchObject({
      key: 'tinfoil:system:https://one/v1',
    })
    expect(resolveAttestationTarget(builtInAgent, model, 'https://two/v1')).toMatchObject({
      key: 'tinfoil:system:https://two/v1',
    })
    expect(resolveAttestationTarget(builtInAgent, { ...model, isSystem: 0 }, 'https://one/v1')).toMatchObject({
      key: 'tinfoil:user',
    })
  })

  it('does not turn a catalog flag into a verification claim', () => {
    expect(resolveAttestationTarget(builtInAgent, { ...model, provider: 'custom' }, '')).toEqual({
      kind: 'unsupported',
      key: 'unsupported:custom',
    })
    expect(resolveAttestationTarget(builtInAgent, { ...model, provider: 'openai', isConfidential: 0 }, '')).toBeNull()
  })

  it('follows the Tinfoil transport even when a custom model lacks the private catalog flag', () => {
    expect(
      resolveAttestationTarget(builtInAgent, { ...model, isSystem: 0, isConfidential: 0 }, 'https://cloud/v1'),
    ).toEqual({ kind: 'local', key: 'tinfoil:user', provider: 'Tinfoil', client: 'user' })
  })
})
