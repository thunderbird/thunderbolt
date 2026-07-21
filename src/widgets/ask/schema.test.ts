/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'bun:test'

import { parse } from './schema'

const optionsJson = JSON.stringify([
  { id: 'a', text: 'Alpha' },
  { id: 'b', text: 'Beta', isCorrect: true },
])

describe('ask schema parse', () => {
  it('parses a current-mode widget with options', () => {
    const result = parse({ prompt: 'Pick one', mode: 'single', options: optionsJson })
    expect(result).not.toBeNull()
    expect(result?.args.mode).toBe('single')
    expect(result?.args.options).toHaveLength(2)
  })

  it('parses legacy free-mode markup with no options (historical messages)', () => {
    const result = parse({ prompt: 'What should we do next?', mode: 'free' })
    expect(result).not.toBeNull()
    expect(result?.args.mode).toBe('free')
    expect(result?.args.options).toBeUndefined()
  })

  it('rejects an unknown mode', () => {
    expect(parse({ prompt: 'Pick one', mode: 'ranked', options: optionsJson })).toBeNull()
  })

  it('rejects fewer than two options when options are present', () => {
    const single = JSON.stringify([{ id: 'a', text: 'Alpha' }])
    expect(parse({ prompt: 'Pick one', mode: 'single', options: single })).toBeNull()
  })

  it('rejects malformed options JSON', () => {
    expect(parse({ prompt: 'Pick one', mode: 'single', options: 'not-json' })).toBeNull()
  })

  it('rejects a missing prompt', () => {
    expect(parse({ mode: 'single', options: optionsJson })).toBeNull()
  })
})
