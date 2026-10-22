/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { toCompilableQuery } from '@powersync/drizzle-driver'
import { useQuery } from '@powersync/tanstack-react-query'
import { useDatabase } from '@/contexts'
import { getArtifactPresentationRecords } from '@/dal/project-artifact-presentation'
import {
  applyArtifactPresentation,
  artifactPresentationKeys,
  artifactPresentationIds,
} from '@/projects/artifact-presentation'

/** Keep names and soft deletion consistent across project, library, pinned and open presentations. */
export const useArtifactPresentation = <T extends { id: string; title: string; legacyIds?: readonly string[] }>(
  artifacts: T[],
  scope: string,
) => {
  const db = useDatabase()
  const keys = artifacts.flatMap((artifact) =>
    artifactPresentationIds(artifact).flatMap((id) => Object.values(artifactPresentationKeys(id))),
  )
  const query = useQuery({
    queryKey: ['artifactPresentation', scope, ...keys],
    placeholderData: (previous, previousQuery) => (previousQuery?.queryKey[1] === scope ? previous : undefined),
    query: toCompilableQuery(getArtifactPresentationRecords(db, keys)),
  })
  const records = query.data ?? []
  const loadedKeys = new Set(records.map((record) => record.key))
  return {
    artifacts: applyArtifactPresentation(
      artifacts.filter((artifact) =>
        artifactPresentationIds(artifact).every((id) => loadedKeys.has(artifactPresentationKeys(id).deletedAt)),
      ),
      records,
    ),
    loading: query.isLoading,
    failed: query.isError,
  }
}
