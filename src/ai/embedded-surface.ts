/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { ArtifactSession } from '@/artifacts/artifact-session-store'

export type EmbeddedSurfaceChoice = 'mini-app' | 'artifact' | null

/** Select a transport adapter from the shared active owner, independent of display mode. */
export const chooseEmbeddedSurface = (session: ArtifactSession | null): EmbeddedSurfaceChoice =>
  session === null ? null : session.kind === 'remote' ? 'mini-app' : 'artifact'
