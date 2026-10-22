/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Trans, useLingui } from '@lingui/react/macro'
import { LayoutGrid, MessageCircle, Pin, PinOff } from 'lucide-react'
import { ArtifactCanvasContext } from '@/artifacts/artifact-canvas-context'
import { ChatHydrateHandler } from '@/chats/detail'
import { ArtifactActions } from '@/components/artifact/artifact-actions'
import { SelectableArtifact } from '@/components/artifact/selectable-artifact'
import ChatUI from '@/components/chat/chat-ui'
import { DetailPanel, DetailPanelSurface } from '@/components/detail-panel'
import { EmbeddedErrorStrip } from '@/components/embedded'
import { Button } from '@/components/ui/button'
import { ActiveContentView } from '@/content-view/active-content-view'
import { cn } from '@/lib/utils'
import type { Project } from '@/types'
import { useProjectArtifactWorkspaceState } from './use-project-artifact-workspace-state'
import type { ProjectArtifact } from './project-artifacts-data'

export const ProjectArtifactWorkspace = ({
  project,
  artifact,
  artifacts,
}: {
  project: Project
  artifact: ProjectArtifact
  artifacts: ProjectArtifact[]
}) => {
  const { t } = useLingui()
  const {
    artifactsDialog,
    chat,
    contentView,
    canvas,
    pins,
    pinned,
    showChat,
    showAside,
    showPanel,
    openSourceChat,
    reveal,
    askAbout,
  } = useProjectArtifactWorkspaceState(project, artifact, artifacts)

  return (
    <ArtifactCanvasContext value={{ toolCallId: artifact.toolCallId, reveal }}>
      <div className="@container/project-artifact relative h-full min-h-0 pt-[var(--header-inset)]">
        <div className="relative flex h-full [--project-chat-width:100cqw] @min-[960px]/project-artifact:[--project-chat-width:clamp(360px,38cqw,480px)]">
          <div
            className={cn(
              'flex min-w-0 flex-1 flex-col pb-4 md:pb-12',
              showPanel && '@max-[960px]/project-artifact:hidden',
            )}
          >
            <header className="flex flex-wrap items-center gap-2 px-4 pb-3 md:px-6">
              <Button
                variant="ghost"
                size="icon"
                aria-label={t`Artifacts`}
                onClick={() => artifactsDialog.open(project.id)}
              >
                <LayoutGrid />
              </Button>
              <div className="min-w-0 flex-1">
                <h1 className="truncate text-sm font-semibold">{artifact.title}</h1>
                <p className="truncate text-xs text-muted-foreground">{project.name}</p>
              </div>
              <Button
                variant="ghost"
                size="icon"
                aria-label={pinned ? t`Unpin from project` : t`Pin to project`}
                aria-pressed={pinned}
                disabled={pins.isSaving}
                onClick={() => void pins.togglePin(artifact.id)}
              >
                {pinned ? <PinOff /> : <Pin />}
              </Button>
              <ArtifactActions html={artifact.html} title={artifact.title} />
              <Button
                variant={showChat ? 'secondary' : 'outline'}
                size="sm"
                aria-pressed={showChat}
                onClick={showChat ? chat.closeChat : openSourceChat}
              >
                <MessageCircle />
                <Trans>Source chat</Trans>
              </Button>
            </header>
            {pins.error && <EmbeddedErrorStrip message={pins.error} />}
            {canvas.error && <EmbeddedErrorStrip message={canvas.error} />}
            <div className="mx-4 min-h-0 flex-1 overflow-hidden rounded-xl border bg-white md:mx-6">
              <SelectableArtifact
                html={artifact.html}
                title={artifact.title}
                onAsk={askAbout}
                onError={canvas.onError}
                onContextChange={canvas.onContextChange}
              />
            </div>
          </div>
          <DetailPanelSurface
            open={showPanel}
            onClose={showAside ? contentView.close : chat.closeChat}
            desktopWidth="var(--project-chat-width)"
          >
            <div className="relative h-full min-h-0">
              {showChat && (
                <div className="h-full min-h-0" inert={showAside}>
                  <DetailPanel
                    handlesKeyboardInset
                    title={artifact.chatTitle}
                    subtitle={t`Source chat`}
                    onClose={chat.closeChat}
                    bodyClassName="-mx-4 gap-0 overflow-hidden md:-mx-6 md:pt-0 max-md:pb-0 max-md:after:hidden"
                  >
                    <div className="min-h-0 flex-1">
                      <ChatHydrateHandler
                        key={artifact.chatThreadId}
                        existingId={artifact.chatThreadId}
                        newChatId={artifact.chatThreadId}
                        projectId={project.id}
                      >
                        <ChatUI />
                      </ChatHydrateHandler>
                    </div>
                  </DetailPanel>
                </div>
              )}
              {showAside && (
                <div className="absolute inset-0 z-10 bg-sidebar">
                  <ActiveContentView />
                </div>
              )}
            </div>
          </DetailPanelSurface>
        </div>
      </div>
    </ArtifactCanvasContext>
  )
}
