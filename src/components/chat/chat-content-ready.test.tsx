/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { act, render } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, spyOn } from 'bun:test'
import { lazy, Suspense } from 'react'
import { beginInitRun, resetInitTiming } from '@/lib/init-timing'
import * as analytics from '@/lib/posthog'
import * as messagesLoader from './chat-messages-loader'
import { getClock } from '@/testing-library'
import { ChatContentReady } from './chat-content-ready'

let trackEvent: ReturnType<typeof spyOn>
let loadMessages: ReturnType<typeof spyOn>

beforeEach(() => {
  resetInitTiming()
  trackEvent = spyOn(analytics, 'trackEvent').mockImplementation(() => {})
  loadMessages = spyOn(messagesLoader, 'loadChatMessageList').mockImplementation(async () => ({
    ChatMessageList: () => <></>,
  }))
})

afterEach(() => {
  trackEvent.mockRestore()
  loadMessages.mockRestore()
  resetInitTiming()
})

it('warms messages after a rendering opportunity without needing a chat route', async () => {
  render(<ChatContentReady />)
  expect(loadMessages).not.toHaveBeenCalled()

  await act(async () => {
    await getClock().tickAsync(16)
  })
  expect(loadMessages).not.toHaveBeenCalled()
  expect(trackEvent).not.toHaveBeenCalled()

  await act(async () => {
    await getClock().tickAsync(16)
  })
  expect(loadMessages).toHaveBeenCalledTimes(1)
  expect(trackEvent).toHaveBeenCalledTimes(1)
})

it('waits for suspended chat content before reporting readiness and warming messages', async () => {
  const pendingPage = Promise.withResolvers<{ default: () => null }>()
  const Page = lazy(() => pendingPage.promise)

  render(
    <Suspense fallback={<div>Loading page</div>}>
      <Page />
      <ChatContentReady />
    </Suspense>,
  )

  await act(async () => {
    await getClock().runAllAsync()
  })
  expect(trackEvent).not.toHaveBeenCalled()
  expect(loadMessages).not.toHaveBeenCalled()

  await act(async () => {
    pendingPage.resolve({ default: () => null })
  })
  await act(async () => {
    await getClock().runAllAsync()
  })
  expect(loadMessages).toHaveBeenCalledTimes(1)
  expect(trackEvent).toHaveBeenCalledWith(
    'app_content_ready',
    expect.objectContaining({ content_ready_ms: expect.any(Number) }),
  )
})

it('cancels pending work on unmount and schedules it again when content remounts', async () => {
  const view = render(<ChatContentReady />)
  view.unmount()

  await act(async () => {
    await getClock().runAllAsync()
  })
  expect(trackEvent).not.toHaveBeenCalled()
  expect(loadMessages).not.toHaveBeenCalled()

  render(<ChatContentReady />)
  await act(async () => {
    await getClock().runAllAsync()
  })
  expect(trackEvent).toHaveBeenCalledTimes(1)
  expect(loadMessages).toHaveBeenCalledTimes(1)
})

it('keeps telemetry one-shot while allowing warmup after an initialization retry', async () => {
  const view = render(<ChatContentReady />)
  await act(async () => {
    await getClock().runAllAsync()
  })
  view.unmount()
  beginInitRun()
  render(<ChatContentReady />)
  expect(loadMessages).toHaveBeenCalledTimes(1)
  await act(async () => {
    await getClock().runAllAsync()
  })
  expect(trackEvent).toHaveBeenCalledTimes(1)
  expect(loadMessages).toHaveBeenCalledTimes(2)
})
