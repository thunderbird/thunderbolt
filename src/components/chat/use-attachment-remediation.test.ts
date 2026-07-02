/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, test } from 'bun:test'

import { nextRemediationTarget } from './use-attachment-remediation'

describe('nextRemediationTarget', () => {
  const caps = (over: Partial<{ canText: boolean; canImages: boolean; hasUsableText: boolean }> = {}) => ({
    canText: true,
    canImages: true,
    hasUsableText: true,
    ...over,
  })

  test('native digital doc → text', () => {
    expect(nextRemediationTarget(undefined, caps())).toBe('text')
  })

  test('native scan (no usable text) → images', () => {
    expect(nextRemediationTarget(undefined, caps({ hasUsableText: false }))).toBe('images')
  })

  test('native with only text transformer → text even if extraction looked empty', () => {
    expect(nextRemediationTarget(undefined, caps({ canImages: false, hasUsableText: false }))).toBe('text')
  })

  test('native with only images transformer → images', () => {
    expect(nextRemediationTarget(undefined, caps({ canText: false, hasUsableText: false }))).toBe('images')
  })

  test('native with no transformers → null', () => {
    expect(
      nextRemediationTarget(undefined, caps({ canText: false, canImages: false, hasUsableText: false })),
    ).toBeNull()
  })

  test('text failed → escalate to images', () => {
    expect(nextRemediationTarget('text', caps())).toBe('images')
  })

  test('text failed with no images transformer → null', () => {
    expect(nextRemediationTarget('text', caps({ canImages: false }))).toBeNull()
  })

  test('images is terminal', () => {
    expect(nextRemediationTarget('images', caps())).toBeNull()
  })
})
