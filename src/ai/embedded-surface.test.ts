/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'bun:test'
import { chooseEmbeddedSurface } from './embedded-surface'

const session = { owner: 'frame', artifactId: 'artifact', inline: false, activated: 1 }

describe('chooseEmbeddedSurface', () => {
  it('has no transport when no artifact is active', () => {
    expect(chooseEmbeddedSurface(null)).toBeNull()
  })
  it('uses the HTML adapter regardless of presentation', () => {
    expect(chooseEmbeddedSurface({ ...session, kind: 'html' })).toBe('artifact')
    expect(chooseEmbeddedSurface({ ...session, kind: 'html', inline: true })).toBe('artifact')
  })
  it('uses the remote adapter regardless of presentation', () => {
    expect(chooseEmbeddedSurface({ ...session, kind: 'remote' })).toBe('mini-app')
    expect(chooseEmbeddedSurface({ ...session, kind: 'remote', inline: true })).toBe('mini-app')
  })
})
