/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { fakeFetch, imageResponse, recordingLogger, routeFor, type FakeRoute } from '@/test-utils/branding'
import type { Branding } from '@shared/branding'
import { describe, expect, it } from 'bun:test'
import { createBrandingAssets } from './assets'
import type { BrandingFetch } from './download'

const css = `/* latin */
@font-face {
  font-family: 'DM Sans';
  font-style: normal;
  font-weight: 100 900;
  src: url(https://fonts.gstatic.com/s/dmsans/latin.woff2) format('woff2');
  unicode-range: U+0000-00FF;
}
`
const googleFonts: FakeRoute = (url) =>
  url.hostname === 'fonts.googleapis.com'
    ? new Response(css)
    : url.hostname === 'fonts.gstatic.com'
      ? new Response('WOFF2')
      : undefined

const lightUrl = 'https://acme.test/light.png'
const darkUrl = 'https://acme.test/dark.svg?signature=secret'

const branding: Branding = {
  cssVars: { theme: { 'font-sans': 'DM Sans' } },
  logo: { light: lightUrl, dark: darkUrl },
}

/** A schedule that holds retries until the test runs them. */
const heldRetries = () => {
  const pending: { retry: () => Promise<void>; delayMs: number }[] = []
  return { pending, schedule: (retry: () => Promise<void>, delayMs: number) => pending.push({ retry, delayMs }) }
}

describe('createBrandingAssets', () => {
  it('serves the fonts and logos it downloaded, each by content name', async () => {
    const { fetchFn } = fakeFetch(
      googleFonts,
      routeFor(lightUrl, imageResponse('PNG', 'image/png')),
      routeFor(darkUrl, imageResponse('<svg/>', 'image/svg+xml')),
    )
    const assets = createBrandingAssets(branding, { fetchFn, logger: recordingLogger() })
    expect(assets.fonts()).toBeUndefined()
    expect(assets.logo()).toBeUndefined()

    await assets.load()

    const [face] = assets.fonts() ?? []
    expect(face).toMatchObject({ family: 'DM Sans', weight: '100 900' })
    expect(assets.file(face.file)?.type).toBe('font/woff2')
    const logo = assets.logo()
    expect(logo?.light.type).toBe('image/png')
    expect(logo?.dark?.type).toBe('image/svg+xml')
    expect(new TextDecoder().decode(assets.file(logo?.light.file ?? '')?.bytes)).toBe('PNG')
    expect(assets.file('00000000000000000000000000000000.png')).toBeUndefined()
  })

  it('keeps the light logo when the dark one fails, and retries the dark one', async () => {
    const darkResponses = [() => new Response('down', { status: 503 }), imageResponse('<svg/>', 'image/svg+xml')]
    const { fetchFn } = fakeFetch(googleFonts, routeFor(lightUrl, imageResponse('PNG', 'image/png')), (url) =>
      url.href === darkUrl ? darkResponses.shift()?.() : undefined,
    )
    const { pending, schedule } = heldRetries()
    const assets = createBrandingAssets(branding, { fetchFn, logger: recordingLogger(), schedule })

    await assets.load()
    expect(assets.logo()?.light.type).toBe('image/png')
    expect(assets.logo()?.dark).toBeUndefined()
    expect(pending.map(({ delayMs }) => delayMs)).toEqual([30_000])

    await pending[0].retry()
    expect(assets.logo()?.dark?.type).toBe('image/svg+xml')
  })

  it('backs off between retries of a download that keeps failing', async () => {
    const { fetchFn } = fakeFetch(() => new Response('down', { status: 503 }))
    const { pending, schedule } = heldRetries()
    const assets = createBrandingAssets(
      { cssVars: { theme: { 'font-sans': 'DM Sans' } } },
      { fetchFn, logger: recordingLogger(), schedule },
    )

    await assets.load()
    await pending[0].retry()

    expect(pending.map(({ delayMs }) => delayMs)).toEqual([30_000, 60_000])
    expect(assets.fonts()).toBeUndefined()
  })

  it('logs the logo host, never the full URL, which may be signed', async () => {
    const logger = recordingLogger()
    const { fetchFn } = fakeFetch(
      routeFor(lightUrl, imageResponse('PNG', 'image/png')),
      () => new Response('', { status: 503 }),
    )
    const assets = createBrandingAssets(
      { logo: { light: lightUrl, dark: darkUrl } },
      { fetchFn, logger, schedule: () => undefined },
    )

    await assets.load()

    expect(JSON.stringify(logger.entries)).not.toContain('signature')
    expect(logger.entries).toContainEqual(
      expect.objectContaining({ level: 'warn', context: expect.objectContaining({ logo: 'dark', host: 'acme.test' }) }),
    )
  })

  it('logs a failure no retry can fix once, as an error, and schedules nothing', async () => {
    const logger = recordingLogger()
    const { fetchFn } = fakeFetch(routeFor(lightUrl, () => new Response('gone', { status: 404 })))
    const { pending, schedule } = heldRetries()
    const assets = createBrandingAssets({ logo: { light: lightUrl } }, { fetchFn, logger, schedule })

    await assets.load()

    expect(pending).toEqual([])
    expect(logger.entries).toEqual([
      expect.objectContaining({ level: 'error', context: expect.objectContaining({ logo: 'light', attempt: 1 }) }),
    ])
  })

  it('caps the backoff at 15 minutes', async () => {
    const { fetchFn } = fakeFetch(() => new Response('down', { status: 503 }))
    const { pending, schedule } = heldRetries()
    const assets = createBrandingAssets({ logo: { light: lightUrl } }, { fetchFn, logger: recordingLogger(), schedule })

    await assets.load()
    for (const index of [0, 1, 2, 3, 4, 5]) {
      await pending[index].retry()
    }

    expect(pending.map(({ delayMs }) => delayMs)).toEqual([30_000, 60_000, 120_000, 240_000, 480_000, 900_000, 900_000])
  })

  it('leaves a family Google does not host to the device, without retrying', async () => {
    const logger = recordingLogger()
    const { fetchFn } = fakeFetch()
    const { pending, schedule } = heldRetries()
    const assets = createBrandingAssets(
      { cssVars: { theme: { 'font-serif': 'Georgia' } } },
      { fetchFn, logger, schedule },
    )

    await assets.load()

    expect(pending).toEqual([])
    expect(logger.entries).toEqual([expect.objectContaining({ level: 'info', context: { family: 'Georgia' } })])
  })

  it('reports whether the first attempts finished within the wait', async () => {
    const { fetchFn } = fakeFetch(googleFonts)
    const assets = createBrandingAssets(
      { cssVars: { theme: { 'font-sans': 'DM Sans' } } },
      { fetchFn, logger: recordingLogger() },
    )

    expect(await assets.loadWithin(1_000)).toBe(true)
    expect(await createBrandingAssets(undefined, { fetchFn, logger: recordingLogger() }).loadWithin(0)).toBe(true)
  })

  it('gives up waiting on a download that hangs, leaving it to land later', async () => {
    const hanging: BrandingFetch = () => new Promise<Response>(() => {})
    const assets = createBrandingAssets(
      { logo: { light: 'https://cdn.test/logo.svg' } },
      { fetchFn: hanging, logger: recordingLogger() },
    )

    expect(await assets.loadWithin(0)).toBe(false)
  })

  it('downloads once however often it is loaded', async () => {
    const { fetchFn, requests } = fakeFetch(googleFonts)
    const assets = createBrandingAssets(
      { cssVars: { theme: { 'font-sans': 'DM Sans' } } },
      { fetchFn, logger: recordingLogger() },
    )
    await assets.load()
    const firstRun = requests.length
    const faces = assets.fonts()?.length

    expect(await assets.loadWithin(1_000)).toBe(true)
    await assets.load()

    expect(requests).toHaveLength(firstRun)
    expect(assets.fonts()?.length).toBe(faces)
  })

  it('requests nothing without branding fonts or logos', async () => {
    const { fetchFn, requests } = fakeFetch()
    const assets = createBrandingAssets({ appName: 'Acme' }, { fetchFn, logger: recordingLogger() })

    await assets.load()

    expect(requests).toEqual([])
  })
})
