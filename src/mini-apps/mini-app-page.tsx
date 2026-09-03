/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Trans, useLingui } from '@lingui/react/macro'
import ChatUI from '@/components/chat/chat-ui'
import { ChatHydrateHandler } from '@/chats/detail'
import { Button } from '@/components/ui/button'
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from '@/components/ui/resizable'
import { MousePointerSquareDashed, PanelRight } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { Navigate, useParams, useSearchParams } from 'react-router'
import { v7 as uuidv7 } from 'uuid'
import { usePendingQuotesStore } from '@/chats/pending-quotes-store'
import { EmbeddedErrorStrip } from '@/components/embedded/surface-status'
import { MarqueeOverlay } from '@/components/embedded/marquee-overlay'
import { SurfaceSelectionBar } from '@/components/embedded/surface-selection-bar'
import { useSurfaceSelection } from '@/components/embedded/use-surface-selection'
import { MiniAppFrame } from './mini-app-frame'
import { SelectionPopover } from '@/components/embedded/selection-popover'
import { useMiniAppStore } from './mini-app-store'
import { findMiniApp, type MiniAppDefinition } from './registry'
import { useMiniApps } from './use-mini-apps'
import { useIsMobile } from '@/hooks/use-mobile'
import { useMiniAppBridge } from './use-mini-app-bridge'
import { useMiniAppChats } from '@/dal/mini-app-chats'
import { MiniAppChatHistory } from './mini-app-chat-history'

/** Default split when the chat opens: roughly two-thirds app, one-third chat. */
const appPanelSize = '66%'
const chatPanelSize = '34%'

/** Composer drafts are stored as plain text under this key (see `use-draft-input.ts`). */
const seedComposerDraft = (chatThreadId: string, prompt: string) => {
  localStorage.setItem(`draft:${chatThreadId}`, prompt)
}

const MiniAppView = ({ app }: { app: MiniAppDefinition }) => {
  const { t } = useLingui()
  /*
   * Two sources, because they are genuinely two states. A persisted thread is
   * addressable, so it lives in `?chat=` and survives a reload or a shared link.
   * A chat the user just opened has no row yet — putting its id in the URL would
   * promise a thread that reloading couldn't find, and hydration would bounce to
   * Not Found. It stays local only until the first message makes it real, at
   * which point `onCreated` promotes it into `?chat=`.
   */
  const [searchParams, setSearchParams] = useSearchParams()
  const [draftChatId, setDraftChatId] = useState<string | null>(null)
  const openChatId = draftChatId ?? searchParams.get('chat')
  const chats = useMiniAppChats(app.id)
  const openApp = useMiniAppStore((s) => s.openApp)
  const closeApp = useMiniAppStore((s) => s.closeApp)

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

  /** Edit only `chat`, leaving any other query the route grows later alone. */
  const setOpenChatParam = useCallback(
    (chatThreadId: string | null) => {
      setSearchParams(
        (current) => {
          const next = new URLSearchParams(current)
          if (chatThreadId) {
            next.set('chat', chatThreadId)
          } else {
            next.delete('chat')
          }
          return next
        },
        { replace: true },
      )
    },
    [setSearchParams],
  )

  const handleChatOpen = useCallback(
    (prompt: string | undefined) => {
      const id = uuidv7()
      if (prompt) {
        seedComposerDraft(id, prompt)
      }
      setDraftChatId(id)
      setOpenChatParam(null)
    },
    [setOpenChatParam],
  )

  const handleOpenExistingChat = useCallback(
    (chatThreadId: string) => {
      setDraftChatId(null)
      setOpenChatParam(chatThreadId)
    },
    [setOpenChatParam],
  )

  const handleCloseChat = useCallback(() => {
    setDraftChatId(null)
    setOpenChatParam(null)
  }, [setOpenChatParam])

  const { frameRef, status, selection, clearSelection, querySelection, runtimeError, handleFrameLoad, reloadFrame } =
    useMiniAppBridge({
      app,
      onChatOpen: handleChatOpen,
    })

  /**
   * Promote a highlighted passage into the composer as a quote chip.
   *
   * Reuses the quote-reply channel (`pending-quotes-store`) that the "Reply" button
   * on an assistant message already uses: same chip, same removal affordance, and
   * on send the passage becomes a real quote part rather than string-concatenated
   * into the user's text. Keyed by thread id, so the chat session must exist first —
   * when the panel is closed we mint the session and attach in the same tick,
   * because the store is keyed, not ordered, and doesn't care that the chat has yet
   * to mount.
   */
  const attachToComposer = useCallback(
    (passages: string[]) => {
      const threadId = openChatId ?? uuidv7()
      if (!openChatId) {
        setDraftChatId(threadId)
      }
      const { addQuote } = usePendingQuotesStore.getState()
      for (const text of passages) {
        addQuote(threadId, { text })
      }
    },
    [openChatId],
  )

  const { mode, startMarquee, dismiss, resolveMarquee, askAboutItems } = useSurfaceSelection({
    query: querySelection,
    onAsk: attachToComposer,
  })

  const handleAskAboutSelection = useCallback(() => {
    if (!selection) {
      return
    }
    attachToComposer([selection.text])
    clearSelection()
  }, [selection, attachToComposer, clearSelection])

  /*
   * One placement. There was a mobile overlay here once; THU-830 replaced it
   * with a size gate above, so the split is the only layout that ships.
   */
  /** Nothing floats over the app while it is still connecting, or while the
   *  marquee owns the surface. */
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
      navigateOnCreate={false}
      // The moment the thread is real it becomes addressable, so it moves out of
      // local state and into the URL. Without this a reload dropped the panel:
      // the id only ever lived in `draftChatId`, which doesn't survive one.
      onCreated={setOpenChatParam}
    >
      <ChatUI />
    </ChatHydrateHandler>
  )

  return (
    /*
     * No header of its own. This used to be a chromeless route that rendered a
     * title bar duplicating the app's own — two rows of chrome saying the same
     * thing — and its hand-rolled sidebar toggle sat on top of the macOS
     * traffic lights, which the shared `Header` already knows to clear.
     *
     * `--header-inset` because the app header floats over content rather than
     * consuming layout height (see `floating-header.tsx`).
     */
    <div className="flex flex-col h-full w-full" style={{ paddingTop: 'var(--header-inset)' }}>
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
            {/* The dim stays up across `resolving`, so releasing the drag doesn't
                flash the app back before the guest has answered. */}
            {(mode.kind === 'drawing' || mode.kind === 'resolving') && (
              <MarqueeOverlay onSelect={resolveMarquee} onCancel={dismiss} />
            )}
            {mode.kind === 'reviewing' && (
              <SurfaceSelectionBar
                items={mode.items}
                onAsk={() => askAboutItems(mode.items)}
                onRetry={startMarquee}
                onCancel={dismiss}
              />
            )}
            {/* Thunderbolt's own affordances, floating over the app rather than
                living inside it — the assistant belongs to the host, so a customer
                app shouldn't have to render (or style) a button to reach it.

                Select stays a labelled button at the bottom: it starts a gesture,
                and an unlabelled marquee icon is not guessable. Opening the chat
                is a panel toggle, so it looks like every other panel toggle —
                an icon, top right. It used to be a large accent-coloured pill
                reading "Close chat", which is not how any other surface in the
                app opens or closes a side panel. */}
            {showFloatingControls && (
              <>
                <div className="absolute top-2 right-2 z-10 flex items-center gap-1">
                  <MiniAppChatHistory chats={chats} onOpenChat={handleOpenExistingChat} />
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={() => (openChatId ? handleCloseChat() : handleChatOpen(undefined))}
                    aria-label={openChatId ? t`Close chat` : t`Open chat`}
                    title={openChatId ? t`Close chat` : t`Open chat`}
                  >
                    <PanelRight className="size-[var(--icon-size-default)]" />
                  </Button>
                </div>
                <div className="absolute bottom-4 right-4 z-10">
                  <Button onClick={startMarquee} variant="secondary" size="lg" className="shadow-lg rounded-full">
                    <MousePointerSquareDashed className="size-[var(--icon-size-sm)]" />
                    <Trans>Select</Trans>
                  </Button>
                </div>
              </>
            )}
          </div>
        </ResizablePanel>
        {openChatId && (
          <>
            <ResizableHandle withHandle />
            <ResizablePanel defaultSize={chatPanelSize} minSize="20%">
              {chatPane}
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
   * split view, highlight-to-ask and the marquee are all pointer-first and need
   * the room, and a 700px browser window is as unworkable as a phone.
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
