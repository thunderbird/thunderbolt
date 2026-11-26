/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import '@/testing-library'
import { PostHogProvider } from '@/lib/posthog'
import { act, renderHook } from '@testing-library/react'
import { describe, expect, mock, test } from 'bun:test'
import type { PostHog } from 'posthog-js'
import type { ReactNode } from 'react'
import { MemoryRouter, useNavigate } from 'react-router'
import { usePageTracking } from './use-analytics'

const renderPageTracking = () => {
  const capture = mock<PostHog['capture']>(() => undefined)
  // The hook only captures, so the stand-in carries nothing else.
  const client: Pick<PostHog, 'capture'> = { capture }
  const wrapper = ({ children }: { children: ReactNode }) => (
    <MemoryRouter initialEntries={['/chats/a']}>
      <PostHogProvider client={client as PostHog}>{children}</PostHogProvider>
    </MemoryRouter>
  )
  const { result } = renderHook(
    () => {
      usePageTracking()
      return useNavigate()
    },
    { wrapper },
  )
  return { navigate: result.current, capture }
}

describe('usePageTracking', () => {
  test('counts a page once per URL, so a navigation that keeps the URL records no new visit', () => {
    const { navigate, capture } = renderPageTracking()
    const origin = window.location.origin

    act(() => {
      void navigate('/chats/a', { state: { from: 'closed-view' } })
    })
    expect(capture.mock.calls).toEqual([['$pageview', { $current_url: `${origin}/chats/a` }]])

    act(() => {
      void navigate('/chats/b')
    })
    expect(capture.mock.calls.slice(1)).toEqual([
      ['$pageleave', { $current_url: `${origin}/chats/a` }],
      ['$pageview', { $current_url: `${origin}/chats/b` }],
    ])
  })
})
