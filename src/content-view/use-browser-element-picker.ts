/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useEffect, useRef, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { usePendingQuotesStore } from '@/chats/pending-quotes-store'
import { parseBrowserPickerResult, toBrowserElementPassage } from './browser-element-reference'

const pickerPollIntervalMs = 150

type PickerState = {
  scope: string
  requestId: string | null
  error: boolean
}

/** Synchronize a native page picker with one tab, document, and owning chat. */
export const useBrowserElementPicker = ({
  tabId,
  label,
  url,
  chatThreadId,
  enabled,
  onAttached,
}: {
  tabId: string
  label: string | null
  url: string
  chatThreadId: string | null
  enabled: boolean
  onAttached?: () => void
}) => {
  const scope = JSON.stringify([tabId, label, url, chatThreadId, enabled])
  const [state, setState] = useState<PickerState>({ scope, requestId: null, error: false })
  const currentScopeRef = useRef(scope)
  const currentRequestRef = useRef<string | null>(null)
  const onAttachedRef = useRef(onAttached)
  currentScopeRef.current = scope
  onAttachedRef.current = onAttached

  // A different document/chat ends the gesture immediately, before a late native reply arrives.
  if (state.scope !== scope) {
    setState({ scope, requestId: null, error: false })
  }
  const requestId = state.scope === scope ? state.requestId : null
  currentRequestRef.current = requestId
  const canPick = Boolean(enabled && label && chatThreadId && /^https?:\/\//.test(url))

  useEffect(() => {
    if (!requestId || !label || !chatThreadId || !canPick) {
      return
    }
    let active = true
    let pollTimer: ReturnType<typeof setTimeout> | undefined
    const isCurrent = () => active && currentScopeRef.current === scope && currentRequestRef.current === requestId
    const finish = (error: boolean) => {
      if (isCurrent()) {
        currentRequestRef.current = null
        setState({ scope, requestId: null, error })
      }
    }
    const onKeyDown = (event: KeyboardEvent) => {
      // The toolbar retains main-webview focus until the user enters the native page.
      if (event.key === 'Escape' && isCurrent()) {
        event.preventDefault()
        finish(false)
      }
    }
    document.addEventListener('keydown', onKeyDown)
    const poll = async () => {
      try {
        const result = parseBrowserPickerResult(await invoke('browser_poll_picker', { label, requestId }))
        if (!isCurrent()) {
          return
        }
        if (result === null) {
          pollTimer = setTimeout(poll, pickerPollIntervalMs)
          return
        }
        if ('cancelled' in result || result.url !== url) {
          finish(false)
          return
        }
        usePendingQuotesStore.getState().addQuote(chatThreadId, { text: toBrowserElementPassage(result, tabId) })
        finish(false)
        onAttachedRef.current?.()
      } catch {
        finish(true)
      }
    }
    const starting = invoke('browser_set_picker', { label, enabled: true, requestId })
    const start = async () => {
      try {
        await starting
        if (isCurrent()) {
          await poll()
        }
      } catch {
        finish(true)
      }
    }
    void start()
    const stop = async () => {
      try {
        await starting
        await invoke('browser_set_picker', { label, enabled: false, requestId })
      } catch (error) {
        console.warn('[browser] Could not dismiss the element picker', error)
      }
    }
    return () => {
      active = false
      document.removeEventListener('keydown', onKeyDown)
      clearTimeout(pollTimer)
      // The native driver ignores cancellations belonging to an older request.
      void stop()
    }
  }, [requestId, label, chatThreadId, canPick, scope, url, tabId])

  return {
    canPick,
    isPicking: requestId !== null,
    error: state.scope === scope && state.error,
    toggle: () => {
      if (canPick) {
        const nextRequestId = requestId ? null : crypto.randomUUID()
        currentRequestRef.current = nextRequestId
        setState({ scope, requestId: nextRequestId, error: false })
      }
    },
    dismiss: () => {
      currentRequestRef.current = null
      setState({ scope, requestId: null, error: false })
    },
  }
}
