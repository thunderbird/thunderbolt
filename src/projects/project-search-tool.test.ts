/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'bun:test'
import { formatProjectChatHits, type ProjectChatHit } from './project-search-tool'

const hit = (chatTitle: string, excerpt: string): ProjectChatHit => ({
  chatThreadId: 'thread-1',
  chatTitle,
  excerpt,
})

describe('formatProjectChatHits', () => {
  it('attributes each excerpt to its source chat', () => {
    const output = formatProjectChatHits([hit('Pricing call', 'we settled on $29')], 'pricing')
    expect(output).toContain('From "Pricing call":')
    expect(output).toContain('we settled on $29')
  })

  it('separates multiple hits', () => {
    const output = formatProjectChatHits([hit('A', 'first'), hit('B', 'second')], 'q')
    expect(output).toContain('From "A":')
    expect(output).toContain('From "B":')
  })

  it('tells the model an empty result may be a vocabulary miss, not an absence', () => {
    const output = formatProjectChatHits([], 'how much should we charge')
    // The single most likely failure of a lexical index is the model concluding
    // "never discussed" when it simply used different words.
    expect(output).toContain('keyword search')
    expect(output).toContain('different wording')
    expect(output).toContain('how much should we charge')
  })
})
