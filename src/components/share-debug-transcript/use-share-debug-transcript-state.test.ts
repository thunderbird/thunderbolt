/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Chat } from '@ai-sdk/react'
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, spyOn } from 'bun:test'
import { createElement, type ReactNode } from 'react'

import { AuthContext } from '@/contexts/auth-context'
import { HttpClientProvider } from '@/contexts/http-client-context'
import { i18n } from '@/i18n'
import type { HttpClient } from '@/lib/http'
import { createMockAuthClient } from '@/test-utils/auth-client'
import { createSpyHttpClient, jsonResponse } from '@/test-utils/http-client-spy'
import { getClock } from '@/testing-library'
import type { ThunderboltUIMessage } from '@/types'
import {
  getDebugTranscriptErrorMessage,
  shareDebugTranscriptReducer,
  type ShareDebugTranscriptEvent,
  type ShareDebugTranscriptState,
  useShareDebugTranscriptState,
} from './use-share-debug-transcript-state'

afterEach(cleanup)

const reducerState: ShareDebugTranscriptState = {
  payload: null,
  consentAccepted: true,
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
      expected: { consentAccepted: false, dialogOpen: false, errorMessage: null, successToastOpen: true, userNote: '' },
    },
    {
      name: 'opening clears stale errors',
      event: { type: 'DIALOG_OPENED', payload: null },
      expected: { dialogOpen: true, errorMessage: null, successToastOpen: false },
    },
    {
      name: 'closing clears the note and consent',
      event: { type: 'DIALOG_CLOSED' },
      expected: { consentAccepted: false, dialogOpen: false, errorMessage: null, userNote: '' },
    },
    {
      name: 'records explicit consent',
      event: { type: 'CONSENT_CHANGED', accepted: false },
      expected: { consentAccepted: false },
    },
  ]

  for (const { name, event, expected } of scenarios) {
    it(name, () => {
      expect(shareDebugTranscriptReducer(reducerState, event)).toMatchObject(expected)
    })
  }
})

describe('getDebugTranscriptErrorMessage', () => {
  const resolve = (status?: number, code?: Parameters<typeof getDebugTranscriptErrorMessage>[1]) =>
    i18n._(getDebugTranscriptErrorMessage(status, code))

  it('maps a disabled feature response to a server-specific message', () => {
    expect(resolve(403, 'DEBUG_TRANSCRIPTS_DISABLED')).toBe('Debug transcript sharing is turned off on this server.')
  })

  it('maps rate limiting before considering the response code', () => {
    expect(resolve(429)).toBe('You have reached the sharing limit. Please try again later.')
  })

  it('maps an oversized transcript response', () => {
    expect(resolve(413, 'DEBUG_TRANSCRIPT_TOO_LARGE')).toBe('This transcript is too large to upload.')
  })

  it('maps unrecognized client errors without inviting retry', () => {
    expect(resolve(422)).toBe('The transcript was rejected by the server.')
  })

  it('reserves the retryable connection message for network and server failures', () => {
    const message = 'We could not send the transcript. Please check your connection and try again.'

    expect(resolve()).toBe(message)
    expect(resolve(500)).toBe(message)
    expect(resolve(502, 'DEBUG_TRANSCRIPT_UPSTREAM_FAILED')).toBe(message)
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
    const { httpClient } = createSpyHttpClient(async () => jsonResponse({ code: 'DEBUG_TRANSCRIPTS_DISABLED' }, 403))
    const chatInstance = createChat()
    const { result } = renderHook(() => useShareDebugTranscriptState({ chatInstance, threadId: 'thread-1' }), {
      wrapper: createHookWrapper(httpClient),
    })

    try {
      act(() => result.current.action.onShare())
      act(() => result.current.dialog.onConsentAcceptedChange(true))
      await flushSubmission(result.current.dialog.onSubmit)
      expect(result.current.dialog.errorMessage).toBe('Debug transcript sharing is turned off on this server.')
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
      act(() => result.current.action.onShare())
      act(() => result.current.dialog.onConsentAcceptedChange(true))
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
      act(() => result.current.action.onShare())
      act(() => result.current.dialog.onConsentAcceptedChange(true))
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
      act(() => result.current.action.onShare())
      act(() => result.current.dialog.onConsentAcceptedChange(true))
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

describe('reviewed transcript', () => {
  it('sends exactly the sanitized preview even if messages change, and clears it on cancel', async () => {
    const requests: string[] = []
    const { httpClient } = createSpyHttpClient(async (request) => {
      requests.push(await request.text())
      return jsonResponse({ id: 'transcript-1' }, 201)
    })
    const chatInstance = createChat()
    const secret = crypto.randomUUID()
    chatInstance.messages = [
      { id: 'm1', role: 'user', parts: [{ type: 'text', text: `Original context client_secret=${secret}` }] },
    ]
    const { result } = renderHook(() => useShareDebugTranscriptState({ chatInstance, threadId: 'thread-1' }), {
      wrapper: createHookWrapper(httpClient),
    })
    act(() => result.current.action.onShare())
    act(() => result.current.dialog.onUserNoteChange(`  Note aws_secret_access_key=${secret}  `))
    const preview = result.current.dialog.preview
    expect(typeof preview).toBe('string')
    expect(preview?.includes(secret)).toBe(false)
    expect(preview).toContain('Original context')
    await flushSubmission(result.current.dialog.onSubmit)
    expect(requests).toHaveLength(0)
    chatInstance.messages = [{ id: 'm2', role: 'user', parts: [{ type: 'text', text: 'Later content' }] }]
    act(() => result.current.dialog.onConsentAcceptedChange(true))
    await flushSubmission(result.current.dialog.onSubmit)
    expect(requests).toHaveLength(1)
    expect(JSON.parse(requests[0]!)).toEqual(JSON.parse(preview!))
    expect(requests[0]?.includes('Later content')).toBe(false)
    expect(result.current.dialog.preview).toBeNull()
    act(() => result.current.action.onShare())
    expect(result.current.dialog.preview).toContain('Later content')
    act(() => result.current.dialog.onCancel())
    expect(result.current.dialog.preview).toBeNull()
    expect(result.current.dialog.consentAccepted).toBe(false)
    expect(requests).toHaveLength(1)
  })
})

it('retains the reviewed payload and note for a retry after an upload failure', async () => {
  const errorLog = spyOn(console, 'error').mockImplementation(() => {})
  const requests: string[] = []
  const { httpClient } = createSpyHttpClient(async (request) => {
    requests.push(await request.text())
    return requests.length === 1
      ? jsonResponse({ code: 'DEBUG_TRANSCRIPT_UPSTREAM_FAILED' }, 502)
      : jsonResponse({ id: 'transcript-1' }, 201)
  })
  const chatInstance = createChat()
  const { result } = renderHook(() => useShareDebugTranscriptState({ chatInstance, threadId: 'thread-1' }), {
    wrapper: createHookWrapper(httpClient),
  })
  try {
    act(() => result.current.action.onShare())
    act(() => result.current.dialog.onUserNoteChange('Ordinary retry context'))
    act(() => result.current.dialog.onConsentAcceptedChange(true))
    const preview = result.current.dialog.preview
    await flushSubmission(result.current.dialog.onSubmit)
    expect(result.current.dialog.open).toBe(true)
    expect(result.current.dialog.preview).toBe(preview)
    expect(result.current.dialog.userNote).toBe('Ordinary retry context')
    await flushSubmission(result.current.dialog.onSubmit)
    expect(requests).toHaveLength(2)
    expect(requests[1]).toBe(requests[0])
    expect(result.current.dialog.open).toBe(false)
  } finally {
    errorLog.mockRestore()
  }
})

it('submits the preview unchanged when the note cap cuts an escaped opening quote', async () => {
  const requests: string[] = []
  const { httpClient } = createSpyHttpClient(async (request) => {
    requests.push(await request.text())
    return jsonResponse({ id: 'capped-quote' }, 201)
  })
  const chatInstance = createChat()
  const { result } = renderHook(() => useShareDebugTranscriptState({ chatInstance, threadId: 'thread-1' }), {
    wrapper: createHookWrapper(httpClient),
  })
  const note =
    'client_secret=x ' +
    'p'.repeat(1959) +
    ' client_secret=' +
    String.fromCharCode(92, 34) +
    'x' +
    String.fromCharCode(92, 34) +
    ' '
  expect(note.length).toBe(1996)
  act(() => result.current.action.onShare())
  act(() => result.current.dialog.onUserNoteChange(note))
  const preview = result.current.dialog.preview!
  act(() => result.current.dialog.onConsentAcceptedChange(true))
  await flushSubmission(result.current.dialog.onSubmit)
  expect(requests).toHaveLength(1)
  expect(requests[0] === JSON.stringify(JSON.parse(preview))).toBe(true)
  expect(requests[0]?.includes('=x')).toBe(false)
})
