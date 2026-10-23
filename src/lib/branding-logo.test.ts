/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useConfigStore } from '@/api/config-store'
import type { HttpClient, ResponsePromise } from '@/lib/http'
import { act, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'bun:test'
import { syncBrandingLogo, useBrandingLogo } from './branding-logo'

/** A client serving each path's bytes from `files`, failing paths not listed. */
const fakeClient = (files: Record<string, string>) => {
  const requests: string[] = []
  const client = {
    get: (url: string) => {
      requests.push(url)
      const body = files[url]
      return (
        body === undefined ? Promise.reject(new Error('offline')) : Promise.resolve(new Response(body))
      ) as ResponsePromise
    },
  } as HttpClient
  return { client, requests }
}

const svgDataUrl = (svg: string) => `data:image/svg+xml;base64,${btoa(svg)}`

// The source store is module state, so each test uses its own file names.
describe('branding logo', () => {
  afterEach(() => {
    useConfigStore.setState({ config: {} })
    document.querySelectorAll('link[rel="icon"]').forEach((link) => link.remove())
  })

  it('shows the default when no logo is configured', () => {
    const { result } = renderHook(() => useBrandingLogo())
    expect(result.current).toEqual({ kind: 'default' })
  })

  it('is loading until the download lands, then serves a data URL and the favicon', async () => {
    const light = { file: 'aaaaaaaaaaaaaaaa.svg', type: 'image/svg+xml' as const }
    useConfigStore.setState({ config: { brandingLogo: { light } } })
    const { result } = renderHook(() => useBrandingLogo())
    expect(result.current).toEqual({ kind: 'loading' })

    const { client, requests } = fakeClient({ [`config/logo/${light.file}`]: '<svg>a</svg>' })
    await act(() => syncBrandingLogo({ light }, client))

    expect(requests).toEqual([`config/logo/${light.file}`])
    expect(result.current).toEqual({ kind: 'branded', src: svgDataUrl('<svg>a</svg>') })
    expect(document.querySelector('link[rel="icon"]')?.getAttribute('href')).toBe(svgDataUrl('<svg>a</svg>'))
  })

  it('falls back to the default when the download fails, instead of staying blank', async () => {
    const light = { file: 'bbbbbbbbbbbbbbbb.png', type: 'image/png' as const }
    useConfigStore.setState({ config: { brandingLogo: { light } } })
    const { result } = renderHook(() => useBrandingLogo())

    await act(() => syncBrandingLogo({ light }, fakeClient({}).client))

    expect(result.current).toEqual({ kind: 'default' })
  })

  it('downloads each file once', async () => {
    const light = { file: 'cccccccccccccccc.svg', type: 'image/svg+xml' as const }
    const { client, requests } = fakeClient({ [`config/logo/${light.file}`]: '<svg/>' })
    await syncBrandingLogo({ light }, client)
    await syncBrandingLogo({ light }, client)

    expect(requests).toHaveLength(1)
  })

  it('ignores a malformed manifest rather than requesting it', async () => {
    const { client, requests } = fakeClient({})
    await syncBrandingLogo({ light: { file: '../../secret', type: 'image/svg+xml' } }, client)

    expect(requests).toEqual([])
  })
})
