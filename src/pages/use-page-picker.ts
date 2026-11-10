/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useEffect, useRef, useState } from 'react'
import { pageController } from './page-controller'
import type { PageSession } from './page-store'
import { useChatStore } from '@/chats/chat-store'
import { usePendingQuotesStore } from '@/chats/pending-quotes-store'
import { parseBrowserPickerResult } from '@/content-view/browser-element-reference'

/** Bind one user gesture to its original page, document and chat, cancelling late replies. */
export const usePagePicker = (session: PageSession | undefined) => {
  const currentChatId = useChatStore((state) => state.currentSessionId)
  const chatId = currentChatId ?? session?.chatThreadId ?? null
  const scope = JSON.stringify([session?.id, session?.browser.url, chatId])
  const [state, setState] = useState<{ scope: string; requestId: string | null; error: boolean }>({
    scope,
    requestId: null,
    error: false,
  })
  const scopeRef = useRef(scope)
  scopeRef.current = scope
  const requestId = state.scope === scope ? state.requestId : null
  const sessionId = session?.id
  const canPick = Boolean(
    session &&
    chatId &&
    (session.page.source.kind === 'html' || (session.browser.url && session.browser.url !== 'about:blank')),
  )
  useEffect(() => {
    if (!requestId || !sessionId || !chatId || !canPick) {
      return
    }
    let alive = true
    let timer: ReturnType<typeof setTimeout> | undefined
    const abort = new AbortController()
    const current = () => alive && scopeRef.current === scope
    const finish = (error: boolean) => {
      if (current()) {
        setState({ scope, requestId: null, error })
      }
    }
    const pending = pageController.adapter(sessionId, abort.signal)
    const poll = async () => {
      try {
        const adapter = await pending
        const result = parseBrowserPickerResult(await adapter.pollPicker?.(requestId))
        if (!current()) {
          return
        }
        if (result === null) {
          timer = setTimeout(poll, 150)
          return
        }
        if ('cancelled' in result) {
          finish(false)
          return
        }
        const reference = {
          pageId: session?.page.id,
          sessionId,
          elementRef: result.element.id,
          url: result.url,
          title: result.title,
          ...result.element.data,
        }
        usePendingQuotesStore.getState().addQuote(chatId, {
          text: `${result.element.label}\n${result.element.text}\nPage reference: ${JSON.stringify(reference)}`,
        })
        finish(false)
      } catch {
        finish(true)
      }
    }
    const start = async () => {
      try {
        const adapter = await pending
        if (!adapter.capabilities.selectElement || !adapter.picker || !adapter.pollPicker) {
          throw new Error('Element selection unavailable')
        }
        await adapter.picker(true, requestId)
        if (current()) {
          await poll()
        }
      } catch {
        finish(true)
      }
    }
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        finish(false)
      }
    }
    document.addEventListener('keydown', escape)
    void start()
    return () => {
      alive = false
      clearTimeout(timer)
      document.removeEventListener('keydown', escape)
      void pending.then((adapter) => adapter.picker?.(false, requestId)).catch(() => {})
      abort.abort()
    }
  }, [requestId, sessionId, chatId, canPick, scope, session?.page.id])
  return {
    canPick,
    isPicking: requestId !== null,
    error: state.scope === scope && state.error,
    toggle: () => {
      if (canPick) {
        setState({ scope, requestId: requestId ? null : crypto.randomUUID(), error: false })
      }
    },
  }
}
