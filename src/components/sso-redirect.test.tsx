/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { AuthContext } from '@/contexts/auth-context'
import { useLocalSettingsStore } from '@/stores/local-settings-store'
import { createMockAuthClient } from '@/test-utils/auth-client'
import { act, cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'bun:test'
import SsoRedirect from './sso-redirect'

const originalCloudUrl = useLocalSettingsStore.getState().cloudUrl
const originalFetch = globalThis.fetch

describe('SsoRedirect', () => {
  afterEach(() => {
    cleanup()
    globalThis.fetch = originalFetch
    useLocalSettingsStore.setState({ cloudUrl: originalCloudUrl })
  })

  it('posts to the exact SSO endpoint when cloudUrl has trailing slashes', async () => {
    const requests: Request[] = []
    globalThis.fetch = Object.assign(
      async (request: RequestInfo | URL) => {
        requests.push(new Request(request))
        return Response.json({ url: 'unsafe redirect fixture' })
      },
      { preconnect: originalFetch.preconnect },
    )
    useLocalSettingsStore.setState({ cloudUrl: 'https://api.example.test/v1///' })
    const authClient = createMockAuthClient()

    render(
      <AuthContext.Provider value={{ authClient }}>
        <SsoRedirect />
      </AuthContext.Provider>,
    )

    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(requests).toHaveLength(1)
    expect(requests[0]?.url).toBe('https://api.example.test/v1/api/auth/sign-in/sso')
    expect(requests[0]?.url).not.toContain('/v1//')

    act(() => useLocalSettingsStore.getState().setLocalSetting('cloudUrl', 'https://api.example.test/v1/'))
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(requests).toHaveLength(1)
  })
})
