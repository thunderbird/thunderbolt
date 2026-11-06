/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Which embedded surface `get_app_context` describes.
 *
 * Both surfaces answer under one tool name, because to the user both are "the
 * thing on my screen" and neither is worth making them name. That only works if
 * the host picks the right one when both are open — which it can be: an app
 * route renders inside the main layout, whose content-view panel hosts
 * artifacts, so opening an artifact from an app's chat leaves both live.
 *
 * A named function rather than a condition inline in request assembly, because
 * it is a rule rather than a detail: the previous version preferred the Mini App
 * unconditionally on the premise that the two could never collide, and a premise
 * buried in an `else if` is one nobody re-checks when it stops holding.
 */

export type EmbeddedSurfaceChoice = 'mini-app' | 'artifact' | null

export type EmbeddedSurfaceCandidates = {
  /** When the Mini App route opened, or null when none is mounted. */
  miniAppOpenedAt: number | null
  /** When the artifact panel opened, or null when it is closed. */
  artifactOpenedAt: number | null
  /**
   * Whether the artifact panel has a title yet.
   *
   * Separate from `artifactOpenedAt` because the panel briefly exists with
   * nothing to say, and describing an artifact whose page has not reported
   * itself is worse than describing the app that has.
   */
  hasArtifactTitle: boolean
}

/**
 * The most recently opened surface wins.
 *
 * Not "the most recently *interacted with*", which would be truer to intent and
 * needs a signal neither surface sends today. Opening is the closest thing we
 * observe, and it gets the common case right: an artifact opened from an app's
 * chat is the thing the user just chose to look at.
 */
export const chooseEmbeddedSurface = ({
  miniAppOpenedAt,
  artifactOpenedAt,
  hasArtifactTitle,
}: EmbeddedSurfaceCandidates): EmbeddedSurfaceChoice => {
  const artifactIsOpen = hasArtifactTitle && artifactOpenedAt !== null
  const miniAppIsOpen = miniAppOpenedAt !== null

  if (artifactIsOpen && miniAppIsOpen) {
    return artifactOpenedAt > miniAppOpenedAt ? 'artifact' : 'mini-app'
  }
  if (artifactIsOpen) {
    return 'artifact'
  }
  return miniAppIsOpen ? 'mini-app' : null
}
