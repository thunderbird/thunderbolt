/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'bun:test'
import { summarize } from './desktop'

describe('summarize', () => {
  it('passes when every check passed', () => {
    const { failed, markdown } = summarize([{ name: 'sign in' }, { name: 'file attach' }])
    expect(failed).toBe(false)
    expect(markdown).toContain('| file attach | passed |')
  })

  it('fails on one failed check and keeps its error on one table row', () => {
    const { failed, markdown } = summarize([{ name: 'sign in' }, { name: 'export', error: 'no file\nin Downloads' }])
    expect(failed).toBe(true)
    expect(markdown).toContain('| export | failed: no file in Downloads |')
  })
})
