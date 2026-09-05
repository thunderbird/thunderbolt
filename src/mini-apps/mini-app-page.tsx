/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Trans } from '@lingui/react/macro'
import ChatUI from '@/components/chat/chat-ui'
import { ChatHydrateHandler } from '@/chats/detail'
import { Button } from '@/components/ui/button'
import { ContentViewHeader } from '@/content-view/header'
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from '@/components/ui/resizable'
import { MessageSquare, MousePointerClick } from 'lucide-react'
import { useCallback, useEffect } from 'react'
import { Navigate, useParams } from 'react-router'
import { EmbeddedErrorStrip } from '@/components/embedded/surface-status'
import { ElementPickOverlay } from '@/components/embedded/element-pick-overlay'
import { useElementPicking } from '@/components/embedded/use-element-picking'
import { MiniAppFrame } from './mini-app-frame'
import { SelectionPopover } from '@/components/embedded/selection-popover'
import { useMiniAppStore } from './mini-app-store'
import { findMiniApp, type MiniAppDefinition } from './registry'
import { useMiniApps } from './use-mini-apps'
import { useIsMobile } from '@/hooks/use-mobile'
import { useMiniAppBridge } from './use-mini-app-bridge'
import { useMiniAppChats } from '@/dal/mini-app-chats'
import { MiniAppChatHistory } from './mini-app-chat-history'
import { useMiniAppChatPanelState } from './use-mini-app-chat-panel-state'

/** Default split when the chat opens: roughly two-thirds app, one-third chat. */
const appPanelSize = '66%'
const chatPanelSize = '34%'

const MiniAppView = ({ app }: { app: MiniAppDefinition }) => {
  const { openChatId, draftChatId, openChat, openExistingChat, closeChat, attachToComposer, handleChatCreated } =
    useMiniAppChatPanelState()
  const chats = useMiniAppChats(app.id)
  const openApp = useMiniAppStore((state) => state.openApp)
  const closeApp = useMiniAppStore((state) => state.closeApp)

  /**
   * Publish which app is open so `src/ai/fetch.ts` can register `get_app_context`
   * and describe the app in the system prompt. A store rather than context
   * because that consumer sits outside the React tree.
   *
   * Legitimate `useEffect` per CLAUDE.md: synchronizing an external store with
   * this component's lifetime, and the unmount cleanup is load-bearing — a stale
   * `activeApp` would leave the tool registered in ordinary chats.
   */
  useEffect(() => {
    openApp(app)
    return () => closeApp()
  }, [app, openApp, closeApp])

  const { frameRef, status, selection, clearSelection, queryElementAt, runtimeError, handleFrameLoad, reloadFrame } =
    useMiniAppBridge({
      app,
      onChatOpen: openChat,
    })

  const { mode, startPicking, dismiss, pointAt, pickAt } = useElementPicking({
    query: queryElementAt,
    onAsk: attachToComposer,
  })

  const handleAskAboutSelection = useCallback(() => {
    if (!selection) {
      return
    }
    attachToComposer([selection.text])
    clearSelection()
  }, [selection, attachToComposer, clearSelection])

  /** Nothing floats over the app while it is still connecting, or while the
   *  element picker owns the surface. */
  const showFloatingControls = status === 'ready' && mode.kind === 'idle'

  const chatPane = openChatId && (
    <ChatHydrateHandler
      // Remounts — and so re-hydrates — when the user switches between chats.
      key={openChatId}
      existingId={draftChatId ? null : openChatId}
      projectId={null}
      // Stamped on the row when the first message persists, so reopening the
      // chat later can say — and show — where it came from.
      miniAppId={app.id}
      newChatId={openChatId}
      // Staying on this route is the whole point: navigating to /chats/<id> on
      // first send would unmount the app, tear down the bridge, and clear the
      // very context the model was asked about.
      // The moment the thread is real it becomes addressable, so it moves out of
      // local state and into the URL. Without this a reload dropped the panel:
      // the id only ever lived in `draftChatId`, which doesn't survive one.
      onCreated={handleChatCreated}
    >
      <ChatUI />
    </ChatHydrateHandler>
  )

  return (
    /*
     * Inset for the shared floating header, like every other route.
     *
     * This went back and forth: a title bar of our own duplicated the app's own
     * header, so it went away, and then the whole header went away on the
     * reasoning that a customer's app is the content rather than a thing inside
     * a frame we label. What that cost was back/forward, the sidebar toggle and
     * the frameless drag region, with floating substitutes overlapping the
     * app's content — a worse trade than the strip of space it saved.
     *
     * `--header-inset` rather than letting the header float over the frame: the
     * app is an opaque cross-origin document, so a header floating above it
     * would sit on top of the app's own controls rather than over a scrim it
     * can fade against.
     */
    <div className="flex h-full w-full flex-col pt-[var(--header-inset)]">
      <ResizablePanelGroup orientation="horizontal" className="flex-1">
        <ResizablePanel defaultSize={openChatId ? appPanelSize : '100%'} minSize="30%">
          <div className="relative flex flex-col h-full">
            <MiniAppFrame
              app={app}
              frameRef={frameRef}
              status={status}
              onFrameLoad={handleFrameLoad}
              onRetry={reloadFrame}
            />
            {/* Same strip an artifact shows for the same situation: the app is
                still on screen and probably still useful, so this sits over it
                rather than replacing it. */}
            {runtimeError && (
              <EmbeddedErrorStrip message={runtimeError} className="absolute inset-x-0 top-0 z-20 border-b-0" />
            )}
            {showFloatingControls && selection?.rect && (
              <SelectionPopover rect={selection.rect} onAsk={handleAskAboutSelection} />
            )}
            {mode.kind === 'picking' && (
              <ElementPickOverlay element={mode.element} onPoint={pointAt} onPick={pickAt} onCancel={dismiss} />
            )}
            {/* Thunderbolt's own affordances, floating over the app rather than
                living inside it — the assistant belongs to the host, so a customer
                app shouldn't have to render (or style) a button to reach it.

                One cluster, bottom right, and only what has nowhere better to
                be. Once the chat is open it has a pane of its own, so the chat
                controls move there rather than staying stacked over the app's
                own top-right corner, which is where a customer app tends to put
                its own controls.

                No sidebar toggle here: the shared header carries it, on this
                route like every other. A copy of it in this cluster was both a
                second control for one job and — because the cluster is gated on
                the app being ready — missing exactly when a failed or slow app
                made getting back out most urgent. */}
            {showFloatingControls && (
              <div className="absolute bottom-4 right-4 z-10 flex items-center gap-2">
                <Button onClick={startPicking} variant="secondary" size="lg" className="shadow-lg rounded-full">
                  <MousePointerClick className="size-[var(--icon-size-sm)]" />
                  <Trans>Select</Trans>
                </Button>
                {!openChatId && (
                  <Button onClick={() => openChat()} size="lg" className="shadow-lg rounded-full">
                    <MessageSquare className="size-[var(--icon-size-sm)]" />
                    <Trans>Chat</Trans>
                  </Button>
                )}
              </div>
            )}
          </div>
        </ResizablePanel>
        {openChatId && (
          <>
            <ResizableHandle withHandle />
            <ResizablePanel defaultSize={chatPanelSize} minSize="20%">
              <div className="flex h-full min-h-0 flex-col">
                {/* The same header every other side panel uses, rather than a
                    strip of our own: it already carries the round close button,
                    the macOS traffic-light clearance and the frameless-caption
                    clearance this panel needs in the window's top-right. */}
                <ContentViewHeader
                  title={app.name}
                  onClose={closeChat}
                  actions={<MiniAppChatHistory chats={chats} onOpenChat={openExistingChat} />}
                />
                <div className="min-h-0 flex-1">{chatPane}</div>
              </div>
            </ResizablePanel>
          </>
        )}
      </ResizablePanelGroup>
    </div>
  )
}

/**
 * Route page for `/apps/:appId`. Unknown ids redirect rather than rendering an
 * error surface — a stale bookmark to a deregistered app should behave like any
 * other bad URL.
 */
export default function MiniAppPage() {
  const { appId } = useParams()
  const { apps, loading, failed } = useMiniApps()
  const { isMobile } = useIsMobile()
  const app = findMiniApp(apps, appId)

  /*
   * Mini Apps are desktop only, gated on viewport rather than platform: the
   * split view, highlight-to-ask and the element picker are all pointer-first
   * and need the room, and a 700px browser window is as unworkable as a phone.
   * `useIsMobile` exempts the Tauri desktop app at any width, so narrowing the
   * desktop window keeps the feature.
   *
   * Rendered as a notice rather than dropped from the route table: a deep link
   * from a synced chat, or someone simply narrowing their window mid-session,
   * should be told what happened instead of hitting Not Found. It names both
   * places the feature *does* work, because "not here" without "there instead"
   * reads as broken rather than unsupported.
   */
  if (isMobile) {
    return (
      <div className="flex h-full items-center justify-center p-8">
        <div className="max-w-sm space-y-2 text-center">
          <p className="text-[length:var(--font-size-body)] font-medium">
            {/* Two whole sentences rather than a name with an English fallback
                spliced in — a fragment like that never reaches translators. */}
            {app ? (
              <Trans>{app.name} is only available on desktop</Trans>
            ) : (
              <Trans>Mini Apps are only available on desktop</Trans>
            )}
          </p>
          <p className="text-[length:var(--font-size-sm)] text-muted-foreground">
            <Trans>
              Open it in the Thunderbolt desktop app, or in a desktop browser. Your chats from this app are still in the
              sidebar.
            </Trans>
          </p>
        </div>
      </div>
    )
  }

  // The registry arrives over the network, so "no such app" isn't knowable until
  // it lands. Redirecting early would bounce a perfectly valid deep link to
  // Not Found whenever someone opened one on a cold load.
  if (loading) {
    return null
  }

  // A failed registry fetch is not an unknown app. Bouncing a valid bookmark to
  // Not Found because the network blipped is both wrong and unrecoverable —
  // this states what happened and leaves the URL intact so a reload retries.
  if (failed) {
    return (
      <div className="flex h-full items-center justify-center p-8">
        <p className="max-w-sm text-center text-[length:var(--font-size-sm)] text-muted-foreground">
          <Trans>Couldn&apos;t load your apps. Check your connection and reload.</Trans>
        </p>
      </div>
    )
  }

  if (!app) {
    return <Navigate to="/not-found" replace />
  }

  // Keyed so navigating between two apps fully remounts the bridge rather than
  // pointing the existing frame at a new origin.
  return <MiniAppView key={app.id} app={app} />
}
