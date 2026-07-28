/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'bun:test'
import { decodeDeploymentId, encodeDeploymentId } from './deployment-id'

describe('deployment id codec', () => {
  it('round-trips provider + ref', () => {
    const id = encodeDeploymentId('haystack', 'tb-my-agent')
    expect(id).toBe('haystack:tb-my-agent')
    expect(decodeDeploymentId(id)).toEqual({ provider: 'haystack', ref: 'tb-my-agent' })
  })

  it('splits on the first separator so refs may contain colons', () => {
    expect(decodeDeploymentId('haystack:a:b:c')).toEqual({ provider: 'haystack', ref: 'a:b:c' })
  })

  it('rejects a provider containing the separator', () => {
    expect(() => encodeDeploymentId('hay:stack', 'ref')).toThrow()
  })

  it('rejects an empty provider or ref', () => {
    expect(() => encodeDeploymentId('', 'ref')).toThrow()
    expect(() => encodeDeploymentId('haystack', '')).toThrow()
  })

  it('rejects malformed ids', () => {
    expect(() => decodeDeploymentId('haystack')).toThrow()
    expect(() => decodeDeploymentId(':ref')).toThrow()
    expect(() => decodeDeploymentId('haystack:')).toThrow()
  })
})
