/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useChat } from '@ai-sdk/react'
import type { ChatStatus } from 'ai'
import { useCallback, useReducer, useRef, useTransition } from 'react'
import { z } from 'zod'

import { messageBookkeepingThrottleMs } from '@/chats/chat-throttle'
import type { ChatSession } from '@/chats/chat-store'
import { useAuth } from '@/contexts/auth-context'
import { useHttpClient } from '@/contexts/http-client-context'
import { submitDebugTranscript } from '@/debug-transcript/api'
import { buildDebugTranscriptPayload } from '@/debug-transcript/build-payload'
import { HttpError, type HttpClient } from '@/lib/http'

const genericErrorMessage = 'We could not send the transcript. Please check your connection and try again.'
const debugTranscriptErrorBodySchema = z.object({ code: z.string().optional() })
const debugTranscriptUploadTimeoutMs = 30_000

type ShareDisabledInput = {
  hasMessages: boolean
  chatStatus: ChatStatus
}

export type ShareDebugTranscriptState = {
  dialogOpen: boolean
  errorMessage: string | null
  menuOpen: boolean
  successToastOpen: boolean
  userNote: string
}

export type ShareDebugTranscriptEvent =
  | { type: 'MENU_CHANGED'; open: boolean }
  | { type: 'DIALOG_OPENED' }
  | { type: 'DIALOG_CLOSED' }
  | { type: 'NOTE_CHANGED'; note: string }
  | { type: 'SUBMIT_STARTED' }
  | { type: 'SUBMIT_SUCCEEDED' }
  | { type: 'SUBMIT_FAILED'; message: string }
  | { type: 'TOAST_DISMISSED' }

type UseShareDebugTranscriptStateOptions = {
  chatInstance: ChatSession['chatInstance']
  threadId: string
}

const initialState: ShareDebugTranscriptState = {
  dialogOpen: false,
  errorMessage: null,
  menuOpen: false,
  successToastOpen: false,
  userNote: '',
}

/** Keep the coupled menu, dialog, and notification transitions atomic. */
export const shareDebugTranscriptReducer = (
  state: ShareDebugTranscriptState,
  action: ShareDebugTranscriptEvent,
): ShareDebugTranscriptState => {
  switch (action.type) {
    case 'MENU_CHANGED':
      return { ...state, menuOpen: action.open }
    case 'DIALOG_OPENED':
      return { ...state, dialogOpen: true, errorMessage: null, menuOpen: false, successToastOpen: false }
    case 'DIALOG_CLOSED':
      return { ...state, dialogOpen: false, errorMessage: null, userNote: '' }
    case 'NOTE_CHANGED':
      return { ...state, userNote: action.note }
    case 'SUBMIT_STARTED':
      return { ...state, errorMessage: null }
    case 'SUBMIT_SUCCEEDED':
      return { ...state, dialogOpen: false, errorMessage: null, successToastOpen: true, userNote: '' }
    case 'SUBMIT_FAILED':
      return { ...state, errorMessage: action.message }
    case 'TOAST_DISMISSED':
      return { ...state, successToastOpen: false }
  }
}

/** Whether transcript sharing must be unavailable for the current chat state. */
export const isShareDebugTranscriptDisabled = ({ hasMessages, chatStatus }: ShareDisabledInput): boolean =>
  !hasMessages || chatStatus === 'submitted' || chatStatus === 'streaming'

/** Convert the debug-transcript API error contract into actionable user copy. */
export const getDebugTranscriptErrorMessage = (status?: number, code?: string): string => {
  if (status === 429) {
    return 'You have reached the sharing limit. Please try again later.'
  }
  if (code === 'DEBUG_TRANSCRIPTS_DISABLED') {
    return 'Debug transcript sharing is turned off on this server.'
  }
  if (code === 'DEBUG_TRANSCRIPT_TOO_LARGE') {
    return 'This transcript is too large to upload.'
  }
  if (code === 'ANONYMOUS_TRANSCRIPT_FORBIDDEN') {
    return 'Sign in to a full account to share a debug transcript.'
  }
  if (status !== undefined && status >= 400 && status < 500) {
    return 'The transcript was rejected by the server.'
  }
  return genericErrorMessage
}

/** Read a typed error code at the HTTP response boundary. */
const readDebugTranscriptErrorCode = async (error: HttpError): Promise<string | undefined> => {
  try {
    const result = debugTranscriptErrorBodySchema.safeParse(await error.response.json())
    return result.success ? result.data.code : undefined
  } catch {
    return undefined
  }
}

/** Apply upload-specific cancellation and timeout controls without changing the transcript API. */
const createDebugTranscriptRequestClient = (httpClient: HttpClient, signal: AbortSignal): HttpClient => ({
  ...httpClient,
  post: (url, options) =>
    httpClient.post(url, {
      ...options,
      signal,
      timeout: debugTranscriptUploadTimeoutMs,
    }),
})

/**
 * Own the complete identified transcript-sharing flow while leaving the menu,
 * dialog, and notification components presentational.
 */
export const useShareDebugTranscriptState = ({ chatInstance, threadId }: UseShareDebugTranscriptStateOptions) => {
  const httpClient = useHttpClient()
  const authClient = useAuth()
  const { data: authSession } = authClient.useSession()
  const { messages, status } = useChat({ chat: chatInstance, experimental_throttle: messageBookkeepingThrottleMs })
  const [state, dispatch] = useReducer(shareDebugTranscriptReducer, initialState)
  const [isPending, startTransition] = useTransition()
  const activeRequestRef = useRef<AbortController | null>(null)

  const closeDialog = () => {
    activeRequestRef.current?.abort()
    activeRequestRef.current = null
    dispatch({ type: 'DIALOG_CLOSED' })
  }

  const handleDialogOpenChange = (open: boolean) => {
    if (open) {
      dispatch({ type: 'DIALOG_OPENED' })
      return
    }
    closeDialog()
  }

  const submit = () => {
    activeRequestRef.current?.abort()
    const controller = new AbortController()
    activeRequestRef.current = controller

    startTransition(async () => {
      dispatch({ type: 'SUBMIT_STARTED' })
      const clientVersion = import.meta.env.VITE_APP_VERSION ?? 'unknown'

      try {
        const payload = buildDebugTranscriptPayload({
          threadId,
          messages: chatInstance.messages,
          authSession: authSession ?? null,
          appVersion: clientVersion,
        })
        await submitDebugTranscript(createDebugTranscriptRequestClient(httpClient, controller.signal), {
          threadId,
          payload,
          userNote: state.userNote,
          clientVersion,
        })
        if (controller.signal.aborted) {
          return
        }
        dispatch({ type: 'SUBMIT_SUCCEEDED' })
      } catch (error) {
        if (controller.signal.aborted) {
          return
        }
        console.error('Failed to share debug transcript:', error)
        if (!(error instanceof HttpError)) {
          dispatch({ type: 'SUBMIT_FAILED', message: getDebugTranscriptErrorMessage() })
          return
        }
        const code = await readDebugTranscriptErrorCode(error)
        dispatch({
          type: 'SUBMIT_FAILED',
          message: getDebugTranscriptErrorMessage(error.response.status, code),
        })
      } finally {
        if (activeRequestRef.current === controller) {
          activeRequestRef.current = null
        }
      }
    })
  }

  const dismissToast = useCallback(() => dispatch({ type: 'TOAST_DISMISSED' }), [])

  return {
    menu: {
      open: state.menuOpen,
      disabled:
        isPending ||
        isShareDebugTranscriptDisabled({
          hasMessages: messages.length > 0,
          chatStatus: status,
        }),
      onOpenChange: (open: boolean) => dispatch({ type: 'MENU_CHANGED', open }),
      onShare: () => dispatch({ type: 'DIALOG_OPENED' }),
    },
    dialog: {
      open: state.dialogOpen,
      userNote: state.userNote,
      errorMessage: state.errorMessage,
      isPending,
      onOpenChange: handleDialogOpenChange,
      onCancel: closeDialog,
      onUserNoteChange: (note: string) => dispatch({ type: 'NOTE_CHANGED', note }),
      onSubmit: submit,
    },
    toast: {
      open: state.successToastOpen,
      onDismiss: dismissToast,
    },
  }
}
