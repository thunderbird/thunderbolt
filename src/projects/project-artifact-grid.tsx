/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useLingui } from '@lingui/react/macro'
import { Virtualizer, type CustomContainerComponentProps, type CustomItemComponentProps } from 'virtua'
import { ProjectArtifactActionsProvider } from './project-artifact-actions-provider'
import { ProjectArtifactCard } from './project-artifact-card'
import type { ProjectArtifact } from './project-artifacts-data'
import { artifactGridGap, useProjectArtifactGridState } from './use-project-artifact-grid-state'

type ProjectArtifactGridProps = {
  projectId: string
  artifacts: ProjectArtifact[]
  pinnedIds: string[]
  isSaving: boolean
  onTogglePin: (id: string) => void
}

/** Expose the full logical collection even though only nearby rows are mounted. */
const ArtifactList = ({ ref, style, children }: CustomContainerComponentProps) => {
  const { t } = useLingui()
  return (
    <div ref={ref} style={style} role="list" aria-label={t`Artifacts`}>
      {children}
    </div>
  )
}

/** Spacing belongs inside the measured wrapper so virtua includes it in row offsets. */
const ArtifactRow = ({ ref, style, children }: CustomItemComponentProps) => (
  <div ref={ref} style={style} role="presentation">
    {children}
  </div>
)

/** Virtualize complete responsive rows, including their sandboxed preview iframes. */
export const ProjectArtifactGrid = ({
  projectId,
  artifacts,
  pinnedIds,
  isSaving,
  onTogglePin,
}: ProjectArtifactGridProps) => {
  const grid = useProjectArtifactGridState(artifacts)

  return (
    <ProjectArtifactActionsProvider>
      <div
        ref={grid.scrollRef}
        data-slot="artifact-grid-scroll"
        className="min-h-0 overflow-y-auto overflow-x-hidden [overflow-anchor:none]"
        style={{ height: grid.height }}
      >
        <Virtualizer
          key={grid.columns}
          scrollRef={grid.scrollRef}
          as={ArtifactList}
          item={ArtifactRow}
          data={grid.rows}
          itemSize={grid.rowHeight}
          bufferSize={grid.rowHeight}
          keepMounted={grid.keepMounted}
        >
          {(row, rowIndex) => (
            <div
              key={row[0].id}
              className="grid gap-4"
              style={{
                gridTemplateColumns: `repeat(${grid.columns}, minmax(0, 1fr))`,
                paddingBottom: rowIndex === grid.rows.length - 1 ? 0 : artifactGridGap,
              }}
            >
              {row.map((artifact, columnIndex) => (
                <ProjectArtifactCard
                  key={artifact.id}
                  ref={grid.measureCard}
                  position={rowIndex * grid.columns + columnIndex + 1}
                  total={artifacts.length}
                  onFocus={() => grid.focusCard(artifact.id)}
                  artifact={artifact}
                  projectId={projectId}
                  pinned={pinnedIds.includes(artifact.id)}
                  isSaving={isSaving}
                  onTogglePin={() => onTogglePin(artifact.id)}
                />
              ))}
            </div>
          )}
        </Virtualizer>
      </div>
    </ProjectArtifactActionsProvider>
  )
}
