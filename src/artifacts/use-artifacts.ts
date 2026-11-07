/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useActiveLocale } from '@/i18n/use-active-locale'
import { toCompilableQuery } from '@powersync/drizzle-driver'
import { useQuery } from '@powersync/tanstack-react-query'
import { useMutation } from '@tanstack/react-query'
import { useDatabase } from '@/contexts'
import {
  artifactsFromMessages,
  getArtifactMessagesQuery,
  getArtifactPinsQuery,
  getPresentedArtifactQuery,
  pinnedArtifactIds,
  resolvePresentedArtifact,
  setArtifactPinned,
  type ArtifactMessageRow,
  type ArtifactPinRow,
  type PresentedArtifactRow,
} from '@/dal/artifacts'
import { useMiniApps } from '@/mini-apps/use-mini-apps'
import { useArtifactPresentation } from './use-artifact-presentation'
import { parseArtifactId, toRemoteArtifact, type Artifact } from './artifact'

type ArtifactsState = { artifacts: Artifact[]; loading: boolean; failed: boolean }

/** Subscribe to source messages; a supplied empty list deliberately reads none. */
const useHtmlArtifacts = (messageIds: readonly string[]): ArtifactsState => {
  useActiveLocale()
  const db = useDatabase()
  const query = useQuery({
    queryKey: ['artifacts', 'messages', messageIds],
    query: toCompilableQuery(getArtifactMessagesQuery(db, messageIds)),
  })
  const presentation = useArtifactPresentation(
    artifactsFromMessages((query.data ?? []) as ArtifactMessageRow[]),
    'html',
  )
  return {
    artifacts: presentation.artifacts,
    loading: query.isLoading || presentation.loading,
    failed: query.isError || presentation.failed,
  }
}

/** Apply saved display names to configured apps without changing their registered identity or URL. */
const useRemoteArtifacts = (): ArtifactsState => {
  const remote = useMiniApps()
  const presentation = useArtifactPresentation(remote.apps.map(toRemoteArtifact), 'remote')
  return {
    artifacts: presentation.artifacts,
    loading: remote.loading || presentation.loading,
    failed: remote.failed || presentation.failed,
  }
}

/** Resolve a deep link even when it is unpinned; HTML does not depend on the remote registry being online. */
export const useArtifact = (
  id: string | undefined,
): { artifact: Artifact | null; loading: boolean; failed: boolean } => {
  const reference = id === undefined ? null : parseArtifactId(id)
  const html = useHtmlArtifacts(reference?.kind === 'html' ? [reference.messageId] : [])
  const remote = useRemoteArtifacts()
  if (!reference) {
    return { artifact: null, loading: false, failed: false }
  }
  if (reference.kind === 'html') {
    return {
      artifact: html.artifacts.find((artifact) => artifact.id === id) ?? null,
      loading: html.loading,
      failed: html.failed,
    }
  }
  return {
    artifact: remote.artifacts.find((candidate) => candidate.id === id) ?? null,
    loading: remote.loading,
    failed: remote.failed,
  }
}

/** Follow persisted updates/deletion while an opened, verified snapshot waits for its first save. */
export const usePresentedArtifact = (snapshot: Artifact): Artifact | null => {
  useActiveLocale()
  const db = useDatabase()
  const reference = snapshot.reference
  const messageId = reference.kind === 'html' ? reference.messageId : null
  const query = useQuery({
    queryKey: ['artifacts', 'presented', messageId],
    query: toCompilableQuery(getPresentedArtifactQuery(db, messageId)),
  })
  const remote = useMiniApps()
  const resolved =
    reference.kind === 'html'
      ? resolvePresentedArtifact(snapshot, (query.data as PresentedArtifactRow[] | undefined)?.[0])
      : remote.loading || remote.failed
        ? snapshot
        : (() => {
            const app = remote.apps.find((candidate) => candidate.id === reference.appId)
            return app ? toRemoteArtifact(app) : null
          })()
  const presentation = useArtifactPresentation(resolved ? [resolved] : [], `presented:${snapshot.id}`)
  return presentation.loading ? resolved : (presentation.artifacts[0] ?? null)
}

/** Resolve just the pinned sources so ordinary sidebar renders do not scan chat history. */
export const usePinnedArtifacts = (): ArtifactsState => {
  const db = useDatabase()
  const pins = useQuery({ queryKey: ['artifactPins'], query: toCompilableQuery(getArtifactPinsQuery(db)) })
  const ids = pinnedArtifactIds((pins.data ?? []) as ArtifactPinRow[])
  const references = ids.flatMap((id) => {
    const reference = parseArtifactId(id)
    return reference ? [reference] : []
  })
  const messageIds = [
    ...new Set(references.flatMap((reference) => (reference.kind === 'html' ? [reference.messageId] : []))),
  ]
  const html = useHtmlArtifacts(messageIds)
  const remote = useRemoteArtifacts()
  const needsRemote = references.some((reference) => reference.kind === 'remote')
  const artifacts = new Map([...html.artifacts, ...remote.artifacts].map((artifact) => [artifact.id, artifact]))
  return {
    artifacts: ids.flatMap((id) => {
      const artifact = artifacts.get(id)
      return artifact ? [artifact] : []
    }),
    loading: pins.isLoading || html.loading || (needsRemote && remote.loading),
    failed: pins.isError || html.failed || (needsRemote && remote.failed),
  }
}

/** A single pin mutation is shared by every presentation of that artifact. */
export const useArtifactPin = (id: string) => {
  const db = useDatabase()
  const query = useQuery({ queryKey: ['artifactPins', id], query: toCompilableQuery(getArtifactPinsQuery(db, id)) })
  const mutation = useMutation({
    mutationKey: ['artifactPin', id],
    mutationFn: (pinned: boolean) => setArtifactPinned(db, id, pinned),
  })
  return {
    pinned: pinnedArtifactIds((query.data ?? []) as ArtifactPinRow[]).includes(id),
    isPending: query.isLoading || mutation.isPending,
    error: mutation.error ?? query.error,
    setPinned: mutation.mutateAsync,
  }
}
