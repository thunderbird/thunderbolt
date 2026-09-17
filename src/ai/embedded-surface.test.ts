/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'bun:test'

import { chooseEmbeddedSurface } from './embedded-surface'

const nothingOpen = { miniAppOpenedAt: null, artifactOpenedAt: null, hasArtifactTitle: false }

describe('chooseEmbeddedSurface', () => {
  it('describes nothing when neither surface is open', () => {
    expect(chooseEmbeddedSurface(nothingOpen)).toBeNull()
  })

  it('describes the app when only an app is open', () => {
    expect(chooseEmbeddedSurface({ ...nothingOpen, miniAppOpenedAt: 100 })).toBe('mini-app')
  })

  it('describes the artifact when only an artifact is open', () => {
    expect(chooseEmbeddedSurface({ miniAppOpenedAt: null, artifactOpenedAt: 100, hasArtifactTitle: true })).toBe(
      'artifact',
    )
  })

  /**
   * The case the old condition got wrong. An app route hosts the content-view
   * panel, so opening an artifact from an app's chat leaves both live — and
   * preferring the app unconditionally described a surface the user had just
   * navigated away from.
   */
  it('describes the artifact when it was opened after the app', () => {
    expect(chooseEmbeddedSurface({ miniAppOpenedAt: 100, artifactOpenedAt: 200, hasArtifactTitle: true })).toBe(
      'artifact',
    )
  })

  it('describes the app when it was opened after the artifact', () => {
    expect(chooseEmbeddedSurface({ miniAppOpenedAt: 200, artifactOpenedAt: 100, hasArtifactTitle: true })).toBe(
      'mini-app',
    )
  })

  /** A panel exists briefly before its page reports a title, and an artifact
   *  that hasn't said what it is loses to an app that has. */
  it('ignores an artifact panel with nothing to say yet', () => {
    expect(chooseEmbeddedSurface({ miniAppOpenedAt: 100, artifactOpenedAt: 200, hasArtifactTitle: false })).toBe(
      'mini-app',
    )
  })

  it('describes nothing when the only open panel has no title', () => {
    expect(chooseEmbeddedSurface({ miniAppOpenedAt: null, artifactOpenedAt: 200, hasArtifactTitle: false })).toBeNull()
  })

  /** Two surfaces opened in the same millisecond is a tie, and a tie has to
   *  resolve to something stable rather than flipping between sends. */
  it('keeps the app on an exact tie', () => {
    expect(chooseEmbeddedSurface({ miniAppOpenedAt: 100, artifactOpenedAt: 100, hasArtifactTitle: true })).toBe(
      'mini-app',
    )
  })
})
