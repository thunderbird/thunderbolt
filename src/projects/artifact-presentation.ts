/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { ProjectArtifact } from './project-artifacts-data'

/** Separate preferences cannot be overwritten when a source conversation saves its messages again. */
export const artifactPresentationKeys = (artifactId: string) => ({
  title: `artifact_title.${artifactId}`,
  deletedAt: `artifact_deleted_at.${artifactId}`,
})

/** Apply user names and soft deletion without altering the original tool output or its source chat. */
export const applyArtifactPresentation = (
  artifacts: readonly ProjectArtifact[],
  settings: readonly { key: string; value: string | null }[],
): ProjectArtifact[] => {
  const values = new Map(settings.map(({ key, value }) => [key, value]))
  return artifacts.flatMap((artifact) => {
    const keys = artifactPresentationKeys(artifact.id)
    if (values.get(keys.deletedAt)) {
      return []
    }
    return [{ ...artifact, title: values.get(keys.title)?.trim() || artifact.title }]
  })
}
