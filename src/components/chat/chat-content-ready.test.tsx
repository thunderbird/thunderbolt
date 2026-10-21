/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { act, render } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, mock, spyOn } from 'bun:test'
import { lazy, Suspense } from 'react'
import { onContentReady, resetInitTiming } from '@/lib/init-timing'
import * as analytics from '@/lib/posthog'
import { getClock } from '@/testing-library'
import { ChatContentReady } from './chat-content-ready'

let trackEvent: ReturnType<typeof spyOn>

beforeEach(() => {
  resetInitTiming()
  trackEvent = spyOn(analytics, 'trackEvent').mockImplementation(() => {})
})

afterEach(() => {
  trackEvent.mockRestore()
  resetInitTiming()
})

it('waits for suspended chat content before reporting readiness', async () => {
  const pendingPage = Promise.withResolvers<{ default: () => null }>()
  const Page = lazy(() => pendingPage.promise)
  const ready = mock()
  onContentReady(ready)

  render(
    <Suspense fallback={<div>Loading page</div>}>
      <Page />
      <ChatContentReady />
    </Suspense>,
  )

  await act(async () => {
    await getClock().runAllAsync()
  })
  expect(ready).not.toHaveBeenCalled()

  await act(async () => {
    pendingPage.resolve({ default: () => null })
  })
  await act(async () => {
    await getClock().runAllAsync()
  })
  expect(ready).toHaveBeenCalledTimes(1)
  expect(trackEvent).toHaveBeenCalledWith(
    'app_content_ready',
    expect.objectContaining({ content_ready_ms: expect.any(Number) }),
  )
})

it('cancels readiness when content unmounts before its rendering opportunity', async () => {
  const ready = mock()
  onContentReady(ready)
  const view = render(<ChatContentReady />)
  view.unmount()

  await act(async () => {
    await getClock().runAllAsync()
  })
  expect(ready).not.toHaveBeenCalled()
})
