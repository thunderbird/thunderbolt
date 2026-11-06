/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'bun:test'
import { normalizeOpenAiBaseUrl } from './openai-base-url'

describe('normalizeOpenAiBaseUrl', () => {
  it('appends /v1 when missing', () => {
    expect(normalizeOpenAiBaseUrl('http://localhost:1234')).toBe('http://localhost:1234/v1')
  })

  it('keeps /v1 when already present', () => {
    expect(normalizeOpenAiBaseUrl('http://localhost:1234/v1')).toBe('http://localhost:1234/v1')
  })

  it('strips trailing slashes before appending /v1', () => {
    expect(normalizeOpenAiBaseUrl('http://localhost:1234/')).toBe('http://localhost:1234/v1')
    expect(normalizeOpenAiBaseUrl('http://localhost:1234///')).toBe('http://localhost:1234/v1')
  })

  it('strips a trailing slash after /v1', () => {
    expect(normalizeOpenAiBaseUrl('http://localhost:1234/v1/')).toBe('http://localhost:1234/v1')
  })

  it('trims surrounding whitespace', () => {
    expect(normalizeOpenAiBaseUrl('  http://localhost:1234  ')).toBe('http://localhost:1234/v1')
  })

  it('appends /v1 even when a non-/v1 path segment is present', () => {
    // We anchor on the exact `/v1` suffix — a `/v1beta` URL gets `/v1` appended.
    // Vendors that expose OpenAI-compat under a sub-path other than `/v1` are rare;
    // users hitting this case can type the full path with a trailing `/v1`.
    expect(normalizeOpenAiBaseUrl('http://x/v1beta')).toBe('http://x/v1beta/v1')
  })
})
