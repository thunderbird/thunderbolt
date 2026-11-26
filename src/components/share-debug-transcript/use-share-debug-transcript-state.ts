/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { MessageDescriptor } from '@lingui/core'
import { msg } from '@lingui/core/macro'
import { useLingui } from '@lingui/react/macro'
import { useCallback, useMemo, useReducer, useRef, useTransition } from 'react'
import { z } from 'zod'

import type { ChatSession } from '@/chats/chat-store'
import { useAuth } from '@/contexts/auth-context'
import { useHttpClient } from '@/contexts/http-client-context'
import { buildDebugTranscriptRequest, submitDebugTranscript } from '@/debug-transcript/api'
import { buildDebugTranscriptPayload } from '@/debug-transcript/build-payload'
import type { DebugTranscriptPayloadV1 } from '@/debug-transcript/types'
import { HttpError } from '@/lib/http'
import {
  debugTranscriptUpstreamFailedCode,
  type DebugTranscriptErrorCode,
  debugTranscriptsDisabledCode,
  debugTranscriptTooLargeCode,
} from '@shared/debug-transcript-contract'

const genericErrorMessage = msg`We could not send the transcript. Please check your connection and try again.`
const debugTranscriptErrorBodySchema = z.object({
  code: z
    .enum([debugTranscriptsDisabledCode, debugTranscriptTooLargeCode, debugTranscriptUpstreamFailedCode])
    .optional(),
})
const debugTranscriptUploadTimeoutMs = 30_000

export type ShareDebugTranscriptState = {
  payload: DebugTranscriptPayloadV1 | null
  consentAccepted: boolean
  dialogOpen: boolean
  errorMessage: string | null
  successToastOpen: boolean
  userNote: string
}

export type ShareDebugTranscriptEvent =
  | { type: 'DIALOG_OPENED'; payload: DebugTranscriptPayloadV1 | null }
  | { type: 'DIALOG_CLOSED' }
  | { type: 'NOTE_CHANGED'; note: string }
  | { type: 'CONSENT_CHANGED'; accepted: boolean }
  | { type: 'SUBMIT_STARTED' }
  | { type: 'SUBMIT_SUCCEEDED' }
  | { type: 'SUBMIT_FAILED'; message: string }
  | { type: 'TOAST_DISMISSED' }

type UseShareDebugTranscriptStateOptions = {
  chatInstance: ChatSession['chatInstance']
  threadId: string
}

const initialState: ShareDebugTranscriptState = {
  payload: null,
  consentAccepted: false,
  dialogOpen: false,
  errorMessage: null,
  successToastOpen: false,
  userNote: '',
}

/** Keep the coupled button, dialog, and notification transitions atomic. */
export const shareDebugTranscriptReducer = (
  state: ShareDebugTranscriptState,
  action: ShareDebugTranscriptEvent,
): ShareDebugTranscriptState => {
  switch (action.type) {
    case 'DIALOG_OPENED':
      return {
        ...state,
        payload: action.payload,
        consentAccepted: false,
        dialogOpen: true,
        errorMessage: null,
        successToastOpen: false,
      }
    case 'DIALOG_CLOSED':
      return { ...state, payload: null, consentAccepted: false, dialogOpen: false, errorMessage: null, userNote: '' }
    case 'NOTE_CHANGED':
      return { ...state, userNote: action.note }
    case 'CONSENT_CHANGED':
      return { ...state, consentAccepted: action.accepted }
    case 'SUBMIT_STARTED':
      return { ...state, errorMessage: null }
    case 'SUBMIT_SUCCEEDED':
      return {
        ...state,
        payload: null,
        consentAccepted: false,
        dialogOpen: false,
        errorMessage: null,
        successToastOpen: true,
        userNote: '',
      }
    case 'SUBMIT_FAILED':
      return { ...state, errorMessage: action.message }
    case 'TOAST_DISMISSED':
      return { ...state, successToastOpen: false }
  }
}

/** Convert the debug-transcript API error contract into actionable user copy. */
export const getDebugTranscriptErrorMessage = (status?: number, code?: DebugTranscriptErrorCode): MessageDescriptor => {
  if (status === 429) {
    return msg`You have reached the sharing limit. Please try again later.`
  }
  if (code === debugTranscriptsDisabledCode) {
    return msg`Debug transcript sharing is turned off on this server.`
  }
  if (code === debugTranscriptTooLargeCode) {
    return msg`This transcript is too large to upload.`
  }
  if (status !== undefined && status >= 400 && status < 500) {
    return msg`The transcript was rejected by the server.`
  }
  return genericErrorMessage
}

/** Read a typed error code at the HTTP response boundary. */
const readDebugTranscriptErrorCode = async (error: HttpError): Promise<DebugTranscriptErrorCode | undefined> => {
  try {
    const result = debugTranscriptErrorBodySchema.safeParse(await error.response.json())
    return result.success ? result.data.code : undefined
  } catch {
    return undefined
  }
}

/**
 * Own the complete identified transcript-sharing flow while leaving the button,
 * dialog, and notification components presentational.
 */
export const useShareDebugTranscriptState = ({ chatInstance, threadId }: UseShareDebugTranscriptStateOptions) => {
  const { i18n, t } = useLingui()
  const httpClient = useHttpClient()
  const authClient = useAuth()
  const { data: authSession } = authClient.useSession()
  const [state, dispatch] = useReducer(shareDebugTranscriptReducer, initialState)
  const [isPending, startTransition] = useTransition()
  const activeRequestRef = useRef<AbortController | null>(null)

  const request = useMemo(
    () =>
      state.payload
        ? buildDebugTranscriptRequest({
            threadId: state.payload.thread.threadId,
            payload: state.payload,
            userNote: state.userNote,
            clientVersion: state.payload.capture.appVersion,
          })
        : null,
    [state.payload, state.userNote],
  )
  const preview = useMemo(() => (request ? JSON.stringify(request, null, 2) : null), [request])

  const openDialog = () => {
    try {
      const payload = buildDebugTranscriptPayload({
        threadId,
        messages: chatInstance.messages,
        authSession: authSession ?? null,
      })
      dispatch({ type: 'DIALOG_OPENED', payload })
    } catch {
      dispatch({ type: 'DIALOG_OPENED', payload: null })
      dispatch({ type: 'SUBMIT_FAILED', message: i18n._(getDebugTranscriptErrorMessage()) })
    }
  }

  const closeDialog = () => {
    activeRequestRef.current?.abort()
    activeRequestRef.current = null
    dispatch({ type: 'DIALOG_CLOSED' })
  }

  const handleDialogOpenChange = (open: boolean) => {
    if (open) {
      openDialog()
      return
    }
    closeDialog()
  }

  const submit = () => {
    if (!state.consentAccepted || !request || isPending) {
      return
    }

    activeRequestRef.current?.abort()
    const controller = new AbortController()
    activeRequestRef.current = controller

    startTransition(async () => {
      dispatch({ type: 'SUBMIT_STARTED' })

      try {
        await submitDebugTranscript(httpClient, {
          ...request,
          // Rebuild from the raw note so a truncated escape cannot change the previewed body.
          userNote: state.userNote,
          signal: controller.signal,
          timeout: debugTranscriptUploadTimeoutMs,
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
          dispatch({ type: 'SUBMIT_FAILED', message: i18n._(getDebugTranscriptErrorMessage()) })
          return
        }
        const code = await readDebugTranscriptErrorCode(error)
        dispatch({
          type: 'SUBMIT_FAILED',
          message: i18n._(getDebugTranscriptErrorMessage(error.response.status, code)),
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
    action: {
      disabledReason: isPending ? t`Sending…` : null,
      onShare: openDialog,
    },
    dialog: {
      open: state.dialogOpen,
      preview,
      userNote: state.userNote,
      consentAccepted: state.consentAccepted,
      errorMessage: state.errorMessage,
      isPending,
      onOpenChange: handleDialogOpenChange,
      onCancel: closeDialog,
      onUserNoteChange: (note: string) => dispatch({ type: 'NOTE_CHANGED', note }),
      onConsentAcceptedChange: (accepted: boolean) => dispatch({ type: 'CONSENT_CHANGED', accepted }),
      onSubmit: submit,
    },
    toast: {
      open: state.successToastOpen,
      onDismiss: dismissToast,
    },
  }
}
