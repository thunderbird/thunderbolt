/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Trans } from '@lingui/react/macro'
import { Link, useParams, useSearchParams } from 'react-router'
import { PageFallback } from '@/loading'
import { useArtifact } from './use-artifacts'
import { ArtifactWorkspace } from './artifact-workspace'

/** Resolve a durable artifact URL without requiring the artifact to be pinned. */
const ArtifactPage = () => {
  const { artifactId } = useParams()
  const [params] = useSearchParams()
  const { artifact, loading, failed } = useArtifact(artifactId)
  if (loading) {
    return <PageFallback />
  }
  if (failed || !artifact) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-4 p-8 text-center">
        <p>
          {failed ? (
            <Trans>Couldn't load this artifact. Check your connection and reload.</Trans>
          ) : (
            <Trans>This artifact is no longer available.</Trans>
          )}
        </p>
        {params.get('chat') && (
          <Link className="underline" to={`/chats/${encodeURIComponent(params.get('chat')!)}?view=chat`}>
            <Trans>Open conversation</Trans>
          </Link>
        )}
        <Link className="underline" to="/chats/new">
          <Trans>Back to chat</Trans>
        </Link>
      </div>
    )
  }
  return <ArtifactWorkspace key={artifact.id} artifact={artifact} />
}
export default ArtifactPage
