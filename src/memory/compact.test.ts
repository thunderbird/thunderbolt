/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'bun:test'
import {
  parseMemoryCompaction,
  compactMemories,
  canCompactMemories,
  maxMemoryCompactionInputBytes,
  validateMemoryCompactionInput,
  MemoryNotShorterError,
} from './compact'
import { createMockModel } from '@/test-utils/chat-store-mocks'
import { mockProxyFetch } from '@/test-utils/proxy-fetch'

describe('memory document compaction', () => {
  it('accepts shorter freeform text and preserves multiline structure', () => {
    expect(
      parseMemoryCompaction(
        ' Preferences:\n- Concise answers.\n- TypeScript. ',
        'The user prefers receiving concise and short answers.\nThe user prefers TypeScript examples.',
      ),
    ).toBe('Preferences:\n- Concise answers.\n- TypeScript.')
  })

  it('rejects empty output as an invalid proposal', () => {
    for (const text of ['', '   ']) {
      expect(() => parseMemoryCompaction(text, 'Original.')).toThrow('empty memory document')
    }
  })

  it('identifies unchanged and larger proposals so the UI can explain that shortening was not possible', () => {
    for (const text of ['Original.', 'A longer replacement document.']) {
      expect(() => parseMemoryCompaction(text, 'Original.')).toThrow(MemoryNotShorterError)
    }
  })

  it('enforces the stored UTF-8 byte limit even when the input is larger', () => {
    expect(() => parseMemoryCompaction('🙂'.repeat(1537), 'x'.repeat(9000))).toThrow('6 KiB')
    expect(parseMemoryCompaction('x'.repeat(6144), 'x'.repeat(9000))).toHaveLength(6144)
  })

  it('allows bounded imported overflow but caps input before inference', async () => {
    expect(canCompactMemories('x'.repeat(maxMemoryCompactionInputBytes))).toBe(true)
    expect(canCompactMemories('x'.repeat(maxMemoryCompactionInputBytes + 1))).toBe(false)
    expect(canCompactMemories(' \n')).toBe(false)
    expect(() => validateMemoryCompactionInput('x'.repeat(9000))).not.toThrow()
    await expect(
      compactMemories({
        content: '🙂'.repeat(7000),
        model: createMockModel(),
        profile: null,
        getProxyFetch: () => mockProxyFetch,
      }),
    ).rejects.toThrow('24 KiB')
  })

  it('honors cancellation before loading the model runtime or starting inference', async () => {
    await expect(
      compactMemories({
        content: 'A personal document.',
        model: createMockModel(),
        profile: null,
        getProxyFetch: () => {
          throw new Error('Must not access transport')
        },
        signal: AbortSignal.abort(new Error('Cancelled')),
      }),
    ).rejects.toThrow('Cancelled')
  })
})
