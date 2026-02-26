import { useCallback, useReducer, useRef } from 'react'
import { isTauri } from '@/lib/platform'
import { isSafeUrl } from '@/lib/url-utils'

const OPEN_FAILED_MESSAGE = 'Could not open link. Please try again or copy the URL.'

type DialogState = {
  dialogOpen: boolean
  pendingUrl: string
  openError: string | null
  isOpening: boolean
}

type DialogAction =
  | { type: 'open'; url: string }
  | { type: 'close' }
  | { type: 'set_open'; open: boolean }
  | { type: 'start_opening' }
  | { type: 'set_error'; error: string }
  | { type: 'reject_unsafe' }

const initialState: DialogState = {
  dialogOpen: false,
  pendingUrl: '',
  openError: null,
  isOpening: false,
}

const dialogReducer = (state: DialogState, action: DialogAction): DialogState => {
  switch (action.type) {
    case 'open':
      return { dialogOpen: true, pendingUrl: action.url, openError: null, isOpening: false }
    case 'close':
      return { ...state, dialogOpen: false }
    case 'set_open':
      return { ...state, dialogOpen: action.open }
    case 'start_opening':
      return { ...state, isOpening: true, openError: null }
    case 'set_error':
      return { ...state, openError: action.error, isOpening: false }
    case 'reject_unsafe':
      return { dialogOpen: false, pendingUrl: '', openError: null, isOpening: false }
  }
}

type UseExternalLinkDialogReturn = {
  dialogOpen: boolean
  pendingUrl: string
  openDialog: (url: string) => void
  handleConfirm: () => Promise<void>
  /** Call when confirm promise rejects (e.g. unhandled throw) to show error in dialog. */
  reportOpenError: () => void
  dismissWithAction: (action: (url: string) => void) => void
  setDialogOpen: (open: boolean) => void
  openError: string | null
  isOpening: boolean
}

/**
 * Hook for managing external link warning dialog state.
 * Encapsulates the common pattern of showing a confirmation dialog
 * before opening external links in a new window.
 * Dialog closes only after a successful open; on failure (e.g. Tauri/openUrl
 * or window.open fails) the dialog stays open and openError is set.
 * Callbacks are stable (useCallback) so context consumers (e.g. SafeLink)
 * do not re-render when the provider re-renders during streaming.
 */
export const useExternalLinkDialog = (): UseExternalLinkDialogReturn => {
  const [state, dispatch] = useReducer(dialogReducer, initialState)
  const pendingUrlRef = useRef<string>('')

  const openDialog = useCallback((url: string) => {
    pendingUrlRef.current = url
    dispatch({ type: 'open', url })
  }, [])

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
      pendingUrlRef.current = ''
      dispatch({ type: 'reject_unsafe' })
      return
    }

    dispatch({ type: 'start_opening' })

    try {
      if (isTauri()) {
        const { openUrl } = await import('@tauri-apps/plugin-opener')
        await openUrl(urlToOpen)
      } else {
        const opened = window.open(urlToOpen, '_blank', 'noopener,noreferrer')
        if (opened === null) {
          dispatch({ type: 'set_error', error: OPEN_FAILED_MESSAGE })
          return
        }
      }
      dispatch({ type: 'close' })
    } catch (error) {
      console.error('Failed to open URL:', error)
      dispatch({ type: 'set_error', error: OPEN_FAILED_MESSAGE })
    }
  }, [])

  const reportOpenError = useCallback(() => {
    dispatch({ type: 'set_error', error: OPEN_FAILED_MESSAGE })
  }, [])

  /** Closes the dialog and invokes `action` with the pending URL. Validates URL with isSafeUrl before invoking (defense-in-depth with handleConfirm). */
  const dismissWithAction = useCallback((action: (url: string) => void) => {
    const url = pendingUrlRef.current
    if (!url) return
    if (!isSafeUrl(url)) {
      console.error('Attempted to open unsafe URL in app:', url)
      dispatch({ type: 'set_error', error: OPEN_FAILED_MESSAGE })
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
    handleConfirm,
    reportOpenError,
    dismissWithAction,
    setDialogOpen,
    openError: state.openError,
    isOpening: state.isOpening,
  }
}
