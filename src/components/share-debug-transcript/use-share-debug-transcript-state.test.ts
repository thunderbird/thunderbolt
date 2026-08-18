/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Chat } from '@ai-sdk/react'
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, spyOn } from 'bun:test'
import { createElement, type ReactNode } from 'react'

import { AuthContext } from '@/contexts/auth-context'
import { HttpClientProvider } from '@/contexts/http-client-context'
import type { HttpClient } from '@/lib/http'
import { createMockAuthClient } from '@/test-utils/auth-client'
import { createSpyHttpClient, jsonResponse } from '@/test-utils/http-client-spy'
import { getClock } from '@/testing-library'
import type { ThunderboltUIMessage } from '@/types'
import {
  getDebugTranscriptErrorMessage,
  getShareDebugTranscriptDisabledReason,
  shareDebugTranscriptReducer,
  type ShareDebugTranscriptEvent,
  type ShareDebugTranscriptState,
  useShareDebugTranscriptState,
} from './use-share-debug-transcript-state'

afterEach(cleanup)

const reducerState: ShareDebugTranscriptState = {
  dialogOpen: true,
  errorMessage: 'Stale error',
  successToastOpen: true,
  userNote: 'Keep this context',
}

describe('shareDebugTranscriptReducer', () => {
  const scenarios: Array<{
    name: string
    event: ShareDebugTranscriptEvent
    expected: Partial<ShareDebugTranscriptState>
  }> = [
    {
      name: 'failed submission preserves the note for retry',
      event: { type: 'SUBMIT_FAILED', message: 'Upload failed' },
      expected: { errorMessage: 'Upload failed', userNote: 'Keep this context' },
    },
    {
      name: 'successful submission closes and clears the form',
      event: { type: 'SUBMIT_SUCCEEDED' },
      expected: { dialogOpen: false, errorMessage: null, successToastOpen: true, userNote: '' },
    },
    {
      name: 'opening clears stale errors',
      event: { type: 'DIALOG_OPENED' },
      expected: { dialogOpen: true, errorMessage: null, successToastOpen: false },
    },
    {
      name: 'closing clears the note',
      event: { type: 'DIALOG_CLOSED' },
      expected: { dialogOpen: false, errorMessage: null, userNote: '' },
    },
  ]

  for (const { name, event, expected } of scenarios) {
    it(name, () => {
      expect(shareDebugTranscriptReducer(reducerState, event)).toMatchObject(expected)
    })
  }
})

describe('getShareDebugTranscriptDisabledReason', () => {
  it('explains response-in-flight states before message availability', () => {
    expect(getShareDebugTranscriptDisabledReason({ hasMessages: false, chatStatus: 'submitted' })).toBe(
      'Wait for the response to finish',
    )
    expect(getShareDebugTranscriptDisabledReason({ hasMessages: true, chatStatus: 'streaming' })).toBe(
      'Wait for the response to finish',
    )
  })

  it('explains that an empty conversation needs messages', () => {
    expect(getShareDebugTranscriptDisabledReason({ hasMessages: false, chatStatus: 'ready' })).toBe(
      'Available once the conversation has messages',
    )
  })

  it('returns no reason when sharing is available', () => {
    expect(getShareDebugTranscriptDisabledReason({ hasMessages: true, chatStatus: 'ready' })).toBeNull()
  })
})

describe('getDebugTranscriptErrorMessage', () => {
  it('maps a disabled feature response to a server-specific message', () => {
    expect(getDebugTranscriptErrorMessage(403, 'DEBUG_TRANSCRIPTS_DISABLED')).toBe(
      'Debug transcript sharing is turned off on this server.',
    )
  })

  it('maps rate limiting before considering the response code', () => {
    expect(getDebugTranscriptErrorMessage(429, 'UNEXPECTED_CODE')).toBe(
      'You have reached the sharing limit. Please try again later.',
    )
  })

  it('maps an oversized transcript response', () => {
    expect(getDebugTranscriptErrorMessage(413, 'DEBUG_TRANSCRIPT_TOO_LARGE')).toBe(
      'This transcript is too large to upload.',
    )
  })

  it('maps anonymous and unrecognized client errors without inviting retry', () => {
    expect(getDebugTranscriptErrorMessage(403, 'ANONYMOUS_TRANSCRIPT_FORBIDDEN')).toBe(
      'Sign in to a full account to share a debug transcript.',
    )
    expect(getDebugTranscriptErrorMessage(422, 'VALIDATION_ERROR')).toBe('The transcript was rejected by the server.')
  })

  it('reserves the retryable connection message for network and server failures', () => {
    const message = 'We could not send the transcript. Please check your connection and try again.'

    expect(getDebugTranscriptErrorMessage()).toBe(message)
    expect(getDebugTranscriptErrorMessage(500)).toBe(message)
  })
})

const createHookWrapper = (httpClient: HttpClient) => {
  const authClient = createMockAuthClient({
    session: { user: { id: 'user-1', email: 'user@example.com' } },
  })

  return ({ children }: { children: ReactNode }) =>
    createElement(HttpClientProvider, {
      httpClient,
      children: createElement(AuthContext.Provider, { value: { authClient } }, children),
    })
}

const createChat = () => new Chat<ThunderboltUIMessage>({ id: 'thread-1', messages: [] })
type PendingRequestState = { current?: Request }

const flushMicrotasks = async () => {
  for (let index = 0; index < 10; index++) {
    await Promise.resolve()
  }
}

const flushSubmission = async (submit: () => void) => {
  await act(async () => {
    submit()
    await flushMicrotasks()
  })
}

describe('useShareDebugTranscriptState errors', () => {
  it('reads a structured HttpError code from the response body', async () => {
    const errorLog = spyOn(console, 'error').mockImplementation(() => {})
    const { httpClient } = createSpyHttpClient(async () =>
      jsonResponse({ code: 'ANONYMOUS_TRANSCRIPT_FORBIDDEN' }, 403),
    )
    const chatInstance = createChat()
    const { result } = renderHook(() => useShareDebugTranscriptState({ chatInstance, threadId: 'thread-1' }), {
      wrapper: createHookWrapper(httpClient),
    })

    try {
      await flushSubmission(result.current.dialog.onSubmit)
      expect(result.current.dialog.errorMessage).toBe('Sign in to a full account to share a debug transcript.')
    } finally {
      errorLog.mockRestore()
    }
  })

  it('shows the connection message for a network TypeError', async () => {
    const errorLog = spyOn(console, 'error').mockImplementation(() => {})
    const { httpClient } = createSpyHttpClient(async () => {
      throw new TypeError('Failed to fetch')
    })
    const chatInstance = createChat()
    const { result } = renderHook(() => useShareDebugTranscriptState({ chatInstance, threadId: 'thread-1' }), {
      wrapper: createHookWrapper(httpClient),
    })

    try {
      await flushSubmission(result.current.dialog.onSubmit)
      expect(result.current.dialog.errorMessage).toBe(
        'We could not send the transcript. Please check your connection and try again.',
      )
    } finally {
      errorLog.mockRestore()
    }
  })

  it('aborts an in-flight request and closes when cancelled', async () => {
    const errorLog = spyOn(console, 'error').mockImplementation(() => {})
    const pendingRequest: PendingRequestState = {}
    const { httpClient } = createSpyHttpClient(
      (request) =>
        new Promise<Response>((_resolve, reject) => {
          pendingRequest.current = request
          request.signal.addEventListener('abort', () => reject(request.signal.reason))
        }),
    )
    const chatInstance = createChat()
    const { result } = renderHook(() => useShareDebugTranscriptState({ chatInstance, threadId: 'thread-1' }), {
      wrapper: createHookWrapper(httpClient),
    })

    try {
      act(() => result.current.action.onShare())
      act(() => result.current.dialog.onSubmit())
      await act(flushMicrotasks)

      expect(pendingRequest.current).toBeDefined()
      expect(result.current.action.disabledReason).toBe('Sending…')
      act(() => result.current.dialog.onCancel())

      expect(pendingRequest.current?.signal.aborted).toBe(true)
      expect(result.current.dialog.open).toBe(false)
      await act(flushMicrotasks)
    } finally {
      errorLog.mockRestore()
    }
  })

  it('times out an upload after thirty seconds', async () => {
    const errorLog = spyOn(console, 'error').mockImplementation(() => {})
    const pendingRequest: PendingRequestState = {}
    const { httpClient } = createSpyHttpClient(
      (request) =>
        new Promise<Response>((_resolve, reject) => {
          pendingRequest.current = request
          request.signal.addEventListener('abort', () => reject(request.signal.reason))
        }),
    )
    const chatInstance = createChat()
    const { result } = renderHook(() => useShareDebugTranscriptState({ chatInstance, threadId: 'thread-1' }), {
      wrapper: createHookWrapper(httpClient),
    })

    try {
      act(() => result.current.dialog.onSubmit())
      await act(flushMicrotasks)
      expect(pendingRequest.current).toBeDefined()

      await act(async () => {
        await getClock().tickAsync(30_000)
        await flushMicrotasks()
      })

      expect(pendingRequest.current?.signal.aborted).toBe(true)
      expect(result.current.dialog.errorMessage).toBe(
        'We could not send the transcript. Please check your connection and try again.',
      )
    } finally {
      errorLog.mockRestore()
    }
  })
})
