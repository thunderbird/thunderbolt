/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { MessageDescriptor } from '@lingui/core'
import { msg } from '@lingui/core/macro'
import { useCallback, useReducer, useRef } from 'react'
import { openExternalUrl } from '@/lib/open-external-url'
import { isSafeUrl } from '@/lib/url-utils'

// `msg` (not `t`) because these live at module scope, and descriptors (not strings)
// because the dialog holds the error in state — a string would freeze whichever
// locale was active when the open failed. The dialog resolves with `i18n._`.
export const openFailedMessage = msg`Could not open link. Please try again or copy the URL.`
/** Retrying can never succeed for a non-http(s) URL, so don't tell the user to. */
export const unsafeUrlMessage = msg`This link uses an address the app cannot open.`

type DialogState = {
  dialogOpen: boolean
  pendingUrl: string
  openError: MessageDescriptor | null
  isOpening: boolean
}

type DialogAction =
  | { type: 'open'; url: string; error?: MessageDescriptor }
  | { type: 'close' }
  | { type: 'set_open'; open: boolean }
  | { type: 'start_opening' }
  | { type: 'set_error'; error: MessageDescriptor }

const initialState: DialogState = {
  dialogOpen: false,
  pendingUrl: '',
  openError: null,
  isOpening: false,
}

const dialogReducer = (state: DialogState, action: DialogAction): DialogState => {
  switch (action.type) {
    case 'open':
      return { dialogOpen: true, pendingUrl: action.url, openError: action.error ?? null, isOpening: false }
    case 'close':
      return { ...state, dialogOpen: false, isOpening: false }
    case 'set_open':
      return { ...state, dialogOpen: action.open }
    case 'start_opening':
      return { ...state, isOpening: true, openError: null }
    case 'set_error':
      return { ...state, openError: action.error, isOpening: false }
  }
}

type UseExternalLinkDialogReturn = {
  dialogOpen: boolean
  pendingUrl: string
  openDialog: (url: string, error?: MessageDescriptor) => void
  openExternally: (url: string) => Promise<void>
  handleConfirm: () => Promise<void>
  dismissWithAction: (action: (url: string) => void) => void
  setDialogOpen: (open: boolean) => void
  openError: MessageDescriptor | null
  isOpening: boolean
}

/**
 * Hook for managing external link warning dialog state.
 * Encapsulates the common pattern of showing a confirmation dialog
 * before opening external links in a new window.
 * Once the dialog is open it closes only after a successful open; on failure
 * (e.g. Tauri/openUrl or window.open fails) it stays open and openError is set.
 * `openExternally` skips the dialog entirely, and raises it only to report a
 * failure — so a failed open there moves it from closed to open.
 * Callbacks are stable (useCallback) so context consumers (e.g. SafeLink)
 * do not re-render when the provider re-renders during streaming.
 */
export const useExternalLinkDialog = (): UseExternalLinkDialogReturn => {
  const [state, dispatch] = useReducer(dialogReducer, initialState)
  const pendingUrlRef = useRef<string>('')

  const openDialog = useCallback((url: string, error?: MessageDescriptor) => {
    pendingUrlRef.current = url
    dispatch({ type: 'open', url, error })
  }, [])

  /**
   * Opens the URL without confirmation (the `browser` link preference).
   * On failure it raises the dialog carrying the reason: a retryable message when
   * the opener failed, or the non-retryable one when the URL isn't http(s).
   */
  const openExternally = useCallback(
    async (url: string) => {
      if (!isSafeUrl(url)) {
        console.error('Attempted to open unsafe URL:', url)
        openDialog(url, unsafeUrlMessage)
        return
      }
      try {
        await openExternalUrl(url)
      } catch (error) {
        console.error('Failed to open URL:', error)
        openDialog(url, openFailedMessage)
      }
    },
    [openDialog],
  )

  const setDialogOpen = useCallback((open: boolean) => {
    dispatch({ type: 'set_open', open })
  }, [])

  const handleConfirm = useCallback(async () => {
    const urlToOpen = pendingUrlRef.current

    if (!urlToOpen) {
      dispatch({ type: 'close' })
      return
    }

    if (!isSafeUrl(urlToOpen)) {
      console.error('Attempted to open unsafe URL:', urlToOpen)
      dispatch({ type: 'set_error', error: unsafeUrlMessage })
      return
    }

    dispatch({ type: 'start_opening' })

    try {
      await openExternalUrl(urlToOpen)
      if (pendingUrlRef.current === urlToOpen) {
        dispatch({ type: 'close' })
      }
    } catch (error) {
      console.error('Failed to open URL:', error)
      if (pendingUrlRef.current === urlToOpen) {
        dispatch({ type: 'set_error', error: openFailedMessage })
      }
    }
  }, [])

  /** Closes the dialog and invokes `action` with the pending URL. Validates URL with isSafeUrl before invoking (defense-in-depth with handleConfirm). */
  const dismissWithAction = useCallback((action: (url: string) => void) => {
    const url = pendingUrlRef.current
    if (!url) {
      return
    }
    if (!isSafeUrl(url)) {
      console.error('Attempted to open unsafe URL in app:', url)
      dispatch({ type: 'set_error', error: unsafeUrlMessage })
      return
    }
    pendingUrlRef.current = ''
    dispatch({ type: 'close' })
    action(url)
  }, [])

  return {
    dialogOpen: state.dialogOpen,
    pendingUrl: state.pendingUrl,
    openDialog,
    openExternally,
    handleConfirm,
    dismissWithAction,
    setDialogOpen,
    openError: state.openError,
    isOpening: state.isOpening,
  }
}
