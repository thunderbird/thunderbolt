/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useReducer } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Trans, useLingui } from '@lingui/react/macro'
import { ArrowLeft, Download } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { SandboxedHtmlFrame } from '@/components/artifact/sandboxed-html-frame'
import { useFormatters } from '@/i18n/use-formatters'
import type { ArtifactClient, SnapshotArtifactView } from '@/artifacts/client'
import { ArtifactError } from './artifact-error'
import { SnapshotArtifactAccess } from './snapshot-artifact-access'
import { useSettings } from '@/hooks/use-settings'
import { usePreparedSave } from '@/components/cloud-agent/use-prepared-save'

type ArtifactFile = { path: string; mediaType: string; content: string }

/** Download a user-selected revision file without disclosing its decrypted content to a server. */
const downloadFile = (file: ArtifactFile) => {
  const url = URL.createObjectURL(new Blob([file.content], { type: file.mediaType }))
  const link = document.createElement('a')
  link.href = url
  link.download = file.path.split('/').at(-1) ?? 'artifact'
  link.click()
  URL.revokeObjectURL(url)
}

const ArtifactFiles = ({
  files,
  save,
  isSaving,
  awaitingSave,
  error,
}: {
  files: ArtifactFile[]
  save: (files: ArtifactFile[]) => void
  isSaving: boolean
  awaitingSave: boolean
  error: unknown
}) => {
  const { t } = useLingui()
  const [state, patch] = useReducer(
    (current: { files: ArtifactFile[]; selected: string; editing: boolean }, value: Partial<typeof current>) => ({
      ...current,
      ...value,
    }),
    { files, selected: files[0]?.path ?? '', editing: false },
  )
  const file = state.files.find((item) => item.path === state.selected)
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <Select value={state.selected} onValueChange={(selected) => patch({ selected })}>
          <SelectTrigger className="min-w-0 flex-1" aria-label={t`Artifact file`}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {state.files.map((item) => (
              <SelectItem key={item.path} value={item.path}>
                {item.path}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button
          variant="ghost"
          size="icon"
          aria-label={t`Download file`}
          disabled={!file}
          onClick={() => file && downloadFile(file)}
        >
          <Download />
        </Button>
      </div>
      {file &&
        (state.editing ? (
          <Textarea
            className="min-h-96 font-mono text-xs"
            disabled={isSaving || awaitingSave}
            aria-label={t`File contents`}
            value={file.content}
            onChange={(event) =>
              patch({
                files: state.files.map((item) =>
                  item.path === file.path ? { ...item, content: event.target.value } : item,
                ),
              })
            }
          />
        ) : file.mediaType.startsWith('text/html') ? (
          <SandboxedHtmlFrame html={file.content} title={file.path} className="h-96 w-full rounded-xl border" />
        ) : (
          <pre className="max-h-[32rem] overflow-auto whitespace-pre-wrap break-words rounded-xl border p-4 text-sm">
            {file.content}
          </pre>
        ))}
      <ArtifactError error={error} />
      <div className="flex justify-end gap-2">
        {state.editing ? (
          <>
            <Button
              variant="ghost"
              disabled={isSaving || awaitingSave}
              onClick={() => patch({ files, editing: false })}
            >
              <Trans>Cancel</Trans>
            </Button>
            <Button disabled={isSaving} onClick={() => save(state.files)}>
              {awaitingSave ? <Trans>Retry save</Trans> : <Trans>Save new revision</Trans>}
            </Button>
          </>
        ) : (
          <Button variant="outline" disabled={!file} onClick={() => patch({ editing: true })}>
            <Trans>Edit files</Trans>
          </Button>
        )}
      </div>
    </div>
  )
}

export const SnapshotArtifactDetails = ({
  client,
  artifact,
  ownerId,
  onBack,
}: {
  client: ArtifactClient
  artifact: SnapshotArtifactView
  ownerId: string
  onBack: () => void
}) => {
  const { t } = useLingui()
  const formatters = useFormatters()
  const { timeFormat } = useSettings({ time_format: '' })
  const queryClient = useQueryClient()
  const [selectedId, selectRevision] = useReducer((_previous: string | null, next: string | null) => next, null)
  const selected =
    artifact.revisions.find(({ record }) => record.id === (selectedId ?? artifact.artifact.currentRevisionId)) ??
    artifact.revisions[0]
  const revisionId = selected?.record.id
  const content = useQuery({
    queryKey: ['artifacts', ownerId, 'content', artifact.artifact.id, revisionId],
    queryFn: () => client.artifactContent(artifact.artifact, revisionId!),
    enabled: !!revisionId,
    retry: false,
    networkMode: 'always',
  })
  const save = usePreparedSave({
    prepare: (files: ArtifactFile[]) =>
      client.prepareArtifact(artifact.artifact, revisionId!, selected.manifest.title, files),
    submit: client.submitArtifact,
    onSuccess: async () => {
      selectRevision(null)
      await queryClient.invalidateQueries({ queryKey: ['artifacts', ownerId, 'list'] })
    },
  })
  return (
    <div className="flex flex-col gap-4">
      <Button variant="ghost" size="sm" className="self-start" onClick={onBack}>
        <ArrowLeft />
        <Trans>Artifacts</Trans>
      </Button>
      <h2 className="text-xl font-semibold">{selected?.manifest.title ?? t`Artifact`}</h2>
      <Select value={revisionId} onValueChange={selectRevision} disabled={save.isPending || save.hasPrepared}>
        <SelectTrigger className="w-full" aria-label={t`Revision history`}>
          <SelectValue placeholder={t`Choose a revision`} />
        </SelectTrigger>
        <SelectContent>
          {artifact.revisions.map(({ record }) => (
            <SelectItem key={record.id} value={record.id}>
              {formatters.date(record.createdAt)} ·{' '}
              {formatters.time(record.createdAt, { hour12: timeFormat.value === '12h' })}
              {record.conflict ? t` · Conflicting revision` : ''}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {selected?.record.conflict && (
        <p className="text-sm text-muted-foreground">
          <Trans>This revision was saved alongside another change. Both versions are preserved.</Trans>
        </p>
      )}
      <ArtifactError error={content.error} />
      {content.isLoading && (
        <p>
          <Trans>Loading artifact…</Trans>
        </p>
      )}
      <SnapshotArtifactAccess client={client} ownerId={ownerId} artifact={artifact.artifact} />
      {content.data && (
        <ArtifactFiles
          key={revisionId}
          files={content.data.files}
          save={(files) => save.mutate(files)}
          isSaving={save.isPending}
          awaitingSave={save.hasPrepared}
          error={save.error}
        />
      )}
    </div>
  )
}
