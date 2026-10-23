/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { Branding } from '@shared/branding'
import { describe, expect, it } from 'bun:test'
import { createBrandingLogo } from './logo'

const recordingLogger = () => {
  const entries: { level: string; message: string; context: Record<string, unknown> }[] = []
  return {
    entries,
    info: (context: Record<string, unknown>, message: string) => entries.push({ level: 'info', message, context }),
    warn: (context: Record<string, unknown>, message: string) => entries.push({ level: 'warn', message, context }),
  }
}

/** A fetch answering each URL from `responses`, recording every request. */
const fakeFetch = (responses: Record<string, () => Response>) => {
  const requests: string[] = []
  const fetchFn = (async (input: string | URL | Request) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    requests.push(url)
    return responses[url]?.() ?? new Response('missing', { status: 404 })
  }) as typeof fetch
  return { fetchFn, requests }
}

const image = (body: string, type: string) => () => new Response(body, { headers: { 'content-type': type } })

const branding = (logo: Branding['logo']): Branding => ({ logo })

describe('createBrandingLogo', () => {
  it('downloads light and dark logos and serves them by content name', async () => {
    const { fetchFn } = fakeFetch({
      'https://acme.test/light.svg': image('<svg>light</svg>', 'image/svg+xml; charset=utf-8'),
      'https://acme.test/dark.png': image('PNGDATA', 'image/png'),
    })
    const logo = createBrandingLogo(
      branding({ light: 'https://acme.test/light.svg', dark: 'https://acme.test/dark.png' }),
      { fetchFn, logger: recordingLogger() },
    )
    expect(logo.manifest()).toBeUndefined()

    await logo.load()

    const manifest = logo.manifest()
    expect(manifest?.light).toEqual({ file: expect.stringMatching(/^[a-f0-9]{32}\.svg$/), type: 'image/svg+xml' })
    expect(manifest?.dark).toEqual({ file: expect.stringMatching(/^[a-f0-9]{32}\.png$/), type: 'image/png' })
    const light = logo.file(manifest?.light.file ?? '')
    expect(light?.type).toBe('image/svg+xml')
    expect(new TextDecoder().decode(light?.bytes)).toBe('<svg>light</svg>')
  })

  it('rejects a non-image type and keeps the default', async () => {
    const logger = recordingLogger()
    const { fetchFn } = fakeFetch({ 'https://acme.test/logo': image('<html></html>', 'text/html') })
    const logo = createBrandingLogo(branding({ light: 'https://acme.test/logo' }), { fetchFn, logger })
    await logo.load()

    expect(logo.manifest()).toBeUndefined()
    expect(logger.entries).toEqual([
      expect.objectContaining({ level: 'warn', context: { error: expect.stringContaining('text/html') } }),
    ])
  })

  it('rejects a logo over 512KB', async () => {
    const logger = recordingLogger()
    const { fetchFn } = fakeFetch({ 'https://acme.test/big.png': image('x'.repeat(512 * 1024 + 1), 'image/png') })
    const logo = createBrandingLogo(branding({ light: 'https://acme.test/big.png' }), { fetchFn, logger })
    await logo.load()

    expect(logo.manifest()).toBeUndefined()
    expect(logger.entries[0].context.error).toContain('limit')
  })

  it('publishes nothing when the dark logo fails, so light and dark stay a pair', async () => {
    const { fetchFn } = fakeFetch({ 'https://acme.test/light.svg': image('<svg/>', 'image/svg+xml') })
    const logo = createBrandingLogo(
      branding({ light: 'https://acme.test/light.svg', dark: 'https://acme.test/gone.svg' }),
      { fetchFn, logger: recordingLogger() },
    )
    await logo.load()

    expect(logo.manifest()).toBeUndefined()
  })

  it('does nothing without a configured logo', async () => {
    const { fetchFn, requests } = fakeFetch({})
    const logo = createBrandingLogo(undefined, { fetchFn, logger: recordingLogger() })
    await logo.load()

    expect(requests).toEqual([])
    expect(logo.manifest()).toBeUndefined()
  })
})
