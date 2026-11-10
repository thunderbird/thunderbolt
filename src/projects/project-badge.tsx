/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { lazy, Suspense, useRef } from 'react'
import { Trans, useLingui } from '@lingui/react/macro'
import { ChevronDown, FolderMinus, Settings } from 'lucide-react'
import { ConfirmActionDialog } from '@/components/ui/confirm-action-dialog'
import { mobileHeaderControlFillClass } from '@/components/ui/modal-styles'
import { SearchableMenu, searchableMenuRowClass } from '@/components/ui/searchable-menu'
import { cn } from '@/lib/utils'
import { ProjectIcon } from './project-icon'
import { ProjectMoveErrorDialog } from './project-move-error-dialog'
import { useProjectBadgeState } from './use-project-badge-state'

// Project configuration stays off the chat's critical loading path.
const ProjectEditorDialog = lazy(async () => {
  const module = await import('./project-editor-dialog')
  return { default: module.ProjectEditorDialog }
})

const ProjectCreateDialog = lazy(async () => {
  const module = await import('./project-create-dialog')
  return { default: module.ProjectCreateDialog }
})

type ProjectBadgeProps = {
  chatThreadId: string | null
  iconOnly?: boolean
  className?: string
}

/** Scope menus and dialogs to their chat so navigation cannot retarget an open form. */
export const ProjectBadge = (props: ProjectBadgeProps) => <ProjectBadgeContent key={props.chatThreadId} {...props} />

/** Choose a chat's project, with a separate settings action for each project. */
const ProjectBadgeContent = ({ chatThreadId, iconOnly = false, className }: ProjectBadgeProps) => {
  const { t } = useLingui()
  const triggerRef = useRef<HTMLDivElement>(null)
  const {
    projects,
    moveError,
    clearMoveError,
    project,
    isVisible,
    dialog,
    openCreate,
    openEdit,
    closeDialog,
    isPending,
    selectProject,
    requestProjectChange,
  } = useProjectBadgeState(chatThreadId)
  if (!isVisible) {
    return null
  }

  const compact = iconOnly || !project
  const label = project ? t`In project: ${project.name}` : t`Choose project`
  const items = projects.map((candidate) => ({
    id: candidate.id,
    label: candidate.name,
    icon: <ProjectIcon icon={candidate.icon} className="size-4 shrink-0 text-muted-foreground" />,
    disabled: isPending,
    action: {
      label: t`Configure ${candidate.name}`,
      icon: <Settings className="size-4" />,
      onAction: () => openEdit(candidate),
    },
  }))

  return (
    <div ref={triggerRef} className="contents">
      <SearchableMenu
        items={items}
        value={project?.id}
        onValueChange={requestProjectChange}
        searchable={projects.length > 10}
        searchPlaceholder={t`Search projects`}
        emptyMessage={t`No matching projects.`}
        mobileTitle={t`Choose project`}
        showDesktopTitle
        mobileSide="top"
        footerAction={[
          ...(project
            ? [
                {
                  label: t`Remove from project`,
                  icon: <FolderMinus className="size-[var(--icon-size-default)]" />,
                  onAction: () => selectProject(null),
                },
              ]
            : []),
          { label: t`Create Project`, onAction: openCreate },
        ]}
        width={240}
        maxHeight={300}
        align={iconOnly ? 'end' : 'start'}
        renderItem={(item) => (
          <div className={cn(searchableMenuRowClass, isPending && 'cursor-wait opacity-60')}>
            {item.icon}
            <span className="min-w-0 flex-1 truncate font-medium">{item.label}</span>
          </div>
        )}
        trigger={(_selected, open) => (
          <div
            title={label}
            className={cn(
              'flex shrink-0 cursor-pointer items-center justify-center rounded-full text-muted-foreground transition-colors',
              compact
                ? cn(
                    'size-[var(--touch-height-sm)] max-md:size-[var(--touch-height-lg)] hover:bg-accent md:dark:hover:bg-secondary/50 active:bg-muted-foreground/20',
                    mobileHeaderControlFillClass,
                  )
                : 'h-[var(--touch-height-sm)] min-w-0 max-w-[14rem] gap-1.5 px-3 text-[length:var(--font-size-body)] hover:bg-accent hover:text-accent-foreground dark:hover:bg-secondary/50',
              open && 'bg-secondary',
              className,
            )}
          >
            <ProjectIcon
              icon={project?.icon}
              className={iconOnly ? 'size-[var(--icon-size-default)] text-[1.05rem]' : 'size-4 text-[0.9rem]'}
            />
            {compact ? (
              <span className="sr-only">{label}</span>
            ) : (
              <>
                <span className="truncate">{project?.name}</span>
                <ChevronDown className={cn('size-3.5 shrink-0 transition-transform', open && 'rotate-180')} />
              </>
            )}
          </div>
        )}
      />
      <ProjectMoveErrorDialog error={moveError} onClose={clearMoveError} />
      {dialog?.type === 'move' && (
        <ConfirmActionDialog
          open
          title={t`Move session?`}
          description={
            <Trans>
              This will move the session to <strong>{dialog.project.name}</strong>.
            </Trans>
          }
          confirmLabel={t`Move`}
          confirmVariant="default"
          onCancel={closeDialog}
          onConfirm={() => {
            selectProject(dialog.project.id)
            closeDialog()
          }}
        />
      )}
      {dialog && dialog.type !== 'move' && (
        <Suspense fallback={null}>
          {dialog.type === 'edit' ? (
            <ProjectEditorDialog project={dialog.project} onClose={closeDialog} />
          ) : (
            <ProjectCreateDialog onClose={closeDialog} onCreated={selectProject} returnFocusRef={triggerRef} />
          )}
        </Suspense>
      )}
    </div>
  )
}
