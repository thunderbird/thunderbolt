/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'bun:test'
import { apiKeyEditValue, hasModelConnectionChanges, modelApiKeyForConnection } from './model-policy'

const model = {
  model: 'gpt-4',
  url: 'https://api.example.com/v1',
}

describe('model edit policy', () => {
  it('does not require a connection test for a name-only edit', () => {
    expect(
      hasModelConnectionChanges(model, {
        model: 'gpt-4',
        url: 'https://api.example.com/v1',
        apiKeyEdit: { kind: 'keep' },
      }),
    ).toBe(false)
  })

  it('marks endpoint, model, and credential edits as connection changes', () => {
    expect(
      hasModelConnectionChanges(model, {
        model: 'gpt-5',
        url: model.url,
        apiKeyEdit: { kind: 'keep' },
      }),
    ).toBe(true)
    expect(
      hasModelConnectionChanges(model, {
        model: model.model,
        url: model.url,
        apiKeyEdit: { kind: 'clear' },
      }),
    ).toBe(true)
  })

  it('maps keep, replace, and clear to DAL semantics', () => {
    expect(apiKeyEditValue({ kind: 'keep' })).toBeUndefined()
    expect(apiKeyEditValue({ kind: 'replace', value: 'new-key' })).toBe('new-key')
    expect(apiKeyEditValue({ kind: 'clear' })).toBeNull()
  })

  it('uses a stored key only for explicit connection actions while keeping it out of the form', () => {
    expect(modelApiKeyForConnection('saved-key', { kind: 'keep' })).toBe('saved-key')
    expect(modelApiKeyForConnection('saved-key', { kind: 'replace', value: 'new-key' })).toBe('new-key')
    expect(modelApiKeyForConnection('saved-key', { kind: 'clear' })).toBeUndefined()
  })
})
