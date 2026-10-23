/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useConfigStore } from '@/api/config-store'
import { createRecordingClient } from '@/test-utils/http-client'
import { ThemeProvider } from '@/lib/theme-provider'
import { useLocalSettingsStore } from '@/stores/local-settings-store'
import type { BrandingLogoManifest } from '@shared/branding'
import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test'
import { clearBrandingLogos, installFavicon, syncBrandingLogos, useBrandingLogo } from './branding-logo'
import { selectBranding } from './branding-selectors'

/** A backend serving each path's bytes from `files`, failing paths not listed. */
const backend = (files: Record<string, string>) => createRecordingClient((path) => files[path])

const svgDataUrl = (svg: string) => `data:image/svg+xml;base64,${btoa(svg)}`

const light = { file: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.svg', type: 'image/svg+xml' as const }
const dark = { file: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb.svg', type: 'image/svg+xml' as const }
const lightPath = `config/branding/${light.file}`

/** Puts a logo in the config store and returns the manifest as `selectBranding` hands it out. */
const configure = (logo: BrandingLogoManifest | undefined) => {
  useConfigStore.setState({ config: { branding: logo ? { logo } : {} } })
  return selectBranding(useConfigStore.getState().config)?.logo
}

const iconHrefs = () => [...document.querySelectorAll('link[rel="icon"]')].map((link) => link.getAttribute('href'))

describe('branding logo', () => {
  const installed: { uninstallFavicon?: () => void } = {}

  beforeEach(() => {
    document.head.appendChild(Object.assign(document.createElement('link'), { rel: 'icon', href: '/favicon.svg' }))
    installed.uninstallFavicon = installFavicon()
  })

  afterEach(() => {
    mock.restore()
    useLocalSettingsStore.setState({ theme: null })
    configure(undefined)
    installed.uninstallFavicon?.()
    clearBrandingLogos()
    document.querySelectorAll('link[rel="icon"]').forEach((link) => link.remove())
  })

  it('shows the default when no logo is configured', () => {
    const { result } = renderHook(() => useBrandingLogo())
    expect(result.current).toEqual({ kind: 'default' })
  })

  it('is loading until the download lands, then serves a data URL and the favicon', async () => {
    const manifest = configure({ light })
    const { result } = renderHook(() => useBrandingLogo())
    expect(result.current).toEqual({ kind: 'loading' })

    const { client, requests } = backend({ [lightPath]: '<svg>a</svg>' })
    await act(() => syncBrandingLogos(manifest, client))

    expect(requests).toEqual([lightPath])
    expect(result.current).toEqual({ kind: 'branded', src: svgDataUrl('<svg>a</svg>') })
    expect(iconHrefs()).toEqual([svgDataUrl('<svg>a</svg>')])
  })

  it('shows the light logo in dark mode when the dark one failed to download', async () => {
    const manifest = configure({ light, dark })
    await syncBrandingLogos(manifest, backend({ [lightPath]: '<svg>l</svg>' }).client)
    useLocalSettingsStore.setState({ theme: 'dark' })
    const { result } = renderHook(() => useBrandingLogo(), { wrapper: ThemeProvider })

    expect(result.current).toEqual({ kind: 'branded', src: svgDataUrl('<svg>l</svg>') })
  })

  it('shows the dark logo in dark mode', async () => {
    const manifest = configure({ light, dark })
    const { client } = backend({ [lightPath]: '<svg>l</svg>', [`config/branding/${dark.file}`]: '<svg>d</svg>' })
    await syncBrandingLogos(manifest, client)
    useLocalSettingsStore.setState({ theme: 'dark' })
    const { result } = renderHook(() => useBrandingLogo(), { wrapper: ThemeProvider })

    expect(result.current).toEqual({ kind: 'branded', src: svgDataUrl('<svg>d</svg>') })
  })

  it('falls back to the default when the download fails, logs it, and retries on the next sync', async () => {
    const warn = spyOn(console, 'warn').mockImplementation(() => {})
    const manifest = configure({ light })
    const { result } = renderHook(() => useBrandingLogo())

    await act(() => syncBrandingLogos(manifest, backend({}).client))
    expect(result.current).toEqual({ kind: 'default' })
    expect(warn).toHaveBeenCalled()
    expect(iconHrefs()).toEqual(['/favicon.svg'])

    const healthy = backend({ [lightPath]: '<svg>b</svg>' })
    await act(() => syncBrandingLogos(manifest, healthy.client))
    expect(healthy.requests).toEqual([lightPath])
    expect(result.current).toEqual({ kind: 'branded', src: svgDataUrl('<svg>b</svg>') })
  })

  it('downloads each file once, even across overlapping syncs', async () => {
    const manifest = configure({ light })
    const { client, requests } = backend({ [lightPath]: '<svg/>' })
    await Promise.all([syncBrandingLogos(manifest, client), syncBrandingLogos(manifest, client)])
    await syncBrandingLogos(manifest, client)

    expect(requests).toHaveLength(1)
  })

  it('restores the bundled favicon when the logo is removed', async () => {
    const manifest = configure({ light })
    await syncBrandingLogos(manifest, backend({ [lightPath]: '<svg/>' }).client)
    expect(iconHrefs()).toEqual([svgDataUrl('<svg/>')])

    configure(undefined)
    expect(iconHrefs()).toEqual(['/favicon.svg'])
  })

  it('leaves the favicon to the current config when an older sync finishes late', async () => {
    const stale = configure({ light })
    configure(undefined)
    await syncBrandingLogos(stale, backend({ [lightPath]: '<svg/>' }).client)

    expect(iconHrefs()).toEqual(['/favicon.svg'])
  })
})
