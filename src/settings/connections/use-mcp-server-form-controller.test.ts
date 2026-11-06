/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'bun:test'
import { resolveCredentialUpdate } from './use-mcp-server-form-controller'

describe('resolveCredentialUpdate', () => {
  it('replaces the stored credential when a token was typed', () => {
    expect(resolveCredentialUpdate('new-token', false, 'bearer')).toEqual({ type: 'bearer', token: 'new-token' })
    // A typed token wins even when the clear toggle was flipped first.
    expect(resolveCredentialUpdate('new-token', true, 'bearer')).toEqual({ type: 'bearer', token: 'new-token' })
  })

  it('deletes only an explicitly cleared stored bearer', () => {
    expect(resolveCredentialUpdate('', true, 'bearer')).toBeNull()
  })

  it('does not delete when clearing but no bearer is stored', () => {
    expect(resolveCredentialUpdate('', true, 'none')).toBeUndefined()
    expect(resolveCredentialUpdate('', true, 'oauth')).toBeUndefined()
  })

  it('keeps the stored credential when the field is untouched', () => {
    expect(resolveCredentialUpdate('', false, 'bearer')).toBeUndefined()
    expect(resolveCredentialUpdate('', false, 'none')).toBeUndefined()
  })
})
