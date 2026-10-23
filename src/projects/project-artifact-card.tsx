/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useMemo, type Ref } from 'react'
import { Trans, useLingui } from '@lingui/react/macro'
import { Code2 } from 'lucide-react'
import { Link } from 'react-router'
import { wrapArtifactPreviewHtml } from '@/artifacts/harness'
import { useFormatters } from '@/i18n/use-formatters'
import type { ProjectArtifact } from './project-artifacts-data'
import { ProjectArtifactContextMenu } from './project-artifact-context-menu'
import { projectArtifactPath } from './project-artifact-path'
import { useProjectArtifactPreviewState } from './use-project-artifact-preview-state'

type ProjectArtifactCardProps = {
  ref?: Ref<HTMLDivElement>
  position?: number
  total?: number
  onFocus?: () => void
  projectId: string
  artifact: ProjectArtifact
  pinned: boolean
  isSaving: boolean
  onTogglePin: () => void
}

/** Static, sandboxed previews never execute the collection's artifacts in the background. */
export const ProjectArtifactCard = ({
  ref,
  position,
  total,
  onFocus,
  projectId,
  artifact,
  pinned,
  isSaving,
  onTogglePin,
}: ProjectArtifactCardProps) => {
  const { t } = useLingui()
  const formatters = useFormatters()
  const preview = useProjectArtifactPreviewState()
  const srcDoc = useMemo(
    () => (preview.ready ? wrapArtifactPreviewHtml(artifact.html) : undefined),
    [artifact.html, preview.ready],
  )
  return (
    <div
      ref={ref}
      role="listitem"
      aria-posinset={position}
      aria-setsize={total}
      onFocusCapture={onFocus}
      className="group relative overflow-hidden rounded-xl border bg-card transition-colors hover:border-foreground/25"
    >
      <ProjectArtifactContextMenu
        projectId={projectId}
        artifact={artifact}
        pinned={pinned}
        isSaving={isSaving}
        onTogglePin={onTogglePin}
      >
        <Link
          to={projectArtifactPath(projectId, artifact.id)}
          aria-label={t`Open ${artifact.title}`}
          className="flow-root rounded-xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
        >
          <div
            ref={preview.ref}
            className="pointer-events-none relative m-2 h-40 overflow-hidden rounded-md bg-muted"
            inert
          >
            {preview.ready && (
              <iframe
                title={t`Preview of ${artifact.title}`}
                srcDoc={srcDoc}
                sandbox=""
                tabIndex={-1}
                aria-hidden
                className="absolute left-0 top-0 h-[300%] w-[300%] origin-top-left scale-[0.333333] border-0 bg-white"
              />
            )}
          </div>
          <div className="px-3 pb-3 pt-1">
            <h2 className="truncate text-sm font-medium">{artifact.title}</h2>
            <p className="mt-1 truncate text-xs text-muted-foreground">{artifact.chatTitle}</p>
            <div className="mt-2 flex items-center gap-1.5 text-xs text-muted-foreground">
              <Code2 className="size-3.5" />
              <span>
                <Trans>HTML</Trans>
              </span>
              <span aria-hidden>·</span>
              <span>{formatters.relativeTime(artifact.createdAt)}</span>
            </div>
          </div>
        </Link>
      </ProjectArtifactContextMenu>
    </div>
  )
}
