/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { Branding } from '@shared/branding'
import { describe, expect, it } from 'bun:test'
import { createBrandingFonts, parseGoogleFontsCss } from './fonts'

// The shape of a real css2 response, trimmed to three subsets.
const dmSansCss = `/* cyrillic */
@font-face {
  font-family: 'DM Sans';
  font-style: normal;
  font-weight: 100 900;
  font-display: swap;
  src: url(https://fonts.gstatic.com/s/dmsans/cyrillic.woff2) format('woff2');
  unicode-range: U+0301, U+0400-045F;
}
/* latin-ext */
@font-face {
  font-family: 'DM Sans';
  font-style: normal;
  font-weight: 100 900;
  font-display: swap;
  src: url(https://fonts.gstatic.com/s/dmsans/latin-ext.woff2) format('woff2');
  unicode-range: U+0100-02BA, U+1E00-1E9F;
}
/* latin */
@font-face {
  font-family: 'DM Sans';
  font-style: italic;
  font-weight: 100 900;
  font-display: swap;
  src: url(https://fonts.gstatic.com/s/dmsans/latin-italic.woff2) format('woff2');
  unicode-range: U+0000-00FF, U+0131;
}
`

const silentLogger = () => {
  const entries: { level: string; message: string; context: Record<string, unknown> }[] = []
  return {
    entries,
    info: (context: Record<string, unknown>, message: string) => entries.push({ level: 'info', message, context }),
    warn: (context: Record<string, unknown>, message: string) => entries.push({ level: 'warn', message, context }),
  }
}

type Route = (url: URL) => Response | undefined

/** A fetch that answers from `routes` and records every request URL. */
const fakeFetch = (...routes: Route[]) => {
  const requests: string[] = []
  const fetchFn = (async (input: string | URL | Request) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
    requests.push(url.href)
    for (const route of routes) {
      const response = route(url)
      if (response) {
        return response
      }
    }
    return new Response('not found', { status: 400 })
  }) as typeof fetch
  return { fetchFn, requests }
}

const fontFiles: Route = (url) =>
  url.hostname === 'fonts.gstatic.com' ? new Response(new TextEncoder().encode(url.pathname)) : undefined

const branding = (fonts: Record<string, string>): Branding => ({ cssVars: { theme: fonts } })

describe('parseGoogleFontsCss', () => {
  it('keeps the latin subsets with their descriptors', () => {
    expect(parseGoogleFontsCss(dmSansCss)).toEqual([
      {
        family: 'DM Sans',
        style: 'normal',
        weight: '100 900',
        unicodeRange: 'U+0100-02BA, U+1E00-1E9F',
        url: 'https://fonts.gstatic.com/s/dmsans/latin-ext.woff2',
      },
      {
        family: 'DM Sans',
        style: 'italic',
        weight: '100 900',
        unicodeRange: 'U+0000-00FF, U+0131',
        url: 'https://fonts.gstatic.com/s/dmsans/latin-italic.woff2',
      },
    ])
  })
})

describe('createBrandingFonts', () => {
  it('downloads a variable font and serves its files by content name', async () => {
    const { fetchFn } = fakeFetch(
      (url) => (url.hostname === 'fonts.googleapis.com' ? new Response(dmSansCss) : undefined),
      fontFiles,
    )
    const fonts = createBrandingFonts(branding({ 'font-sans': '"DM Sans", sans-serif' }), {
      fetchFn,
      logger: silentLogger(),
    })
    expect(fonts.faces()).toEqual([])

    await fonts.load()

    const faces = fonts.faces()
    expect(faces).toHaveLength(2)
    expect(faces[0]).toMatchObject({ family: 'DM Sans', style: 'normal', weight: '100 900' })
    expect(faces[0].file).toMatch(/^[a-f0-9]{32}\.woff2$/)
    expect(new TextDecoder().decode(fonts.file(faces[0].file))).toBe('/s/dmsans/latin-ext.woff2')
    expect(fonts.file('0000000000000000.woff2')).toBeUndefined()
  })

  it('falls back to static weights when Google rejects the variable range', async () => {
    const { fetchFn, requests } = fakeFetch(
      (url) =>
        url.hostname === 'fonts.googleapis.com' && url.search.includes('0,400;0,700')
          ? new Response(dmSansCss.replaceAll('DM Sans', 'Space Mono'))
          : undefined,
      fontFiles,
    )
    const fonts = createBrandingFonts(branding({ 'font-mono': 'Space Mono, monospace' }), {
      fetchFn,
      logger: silentLogger(),
    })
    await fonts.load()

    expect(requests[0]).toContain('family=Space+Mono:ital,wght@0,100..900')
    expect(fonts.faces().map((face) => face.family)).toEqual(['Space Mono', 'Space Mono'])
  })

  it('leaves a family Google lacks to the device, without an error', async () => {
    const logger = silentLogger()
    const { fetchFn, requests } = fakeFetch()
    const fonts = createBrandingFonts(branding({ 'font-serif': 'Georgia, serif' }), { fetchFn, logger })
    await fonts.load()

    expect(fonts.faces()).toEqual([])
    expect(requests).toHaveLength(4)
    expect(logger.entries).toEqual([expect.objectContaining({ level: 'info', context: { family: 'Georgia' } })])
  })

  it('publishes nothing for a family whose files fail, and logs a warning', async () => {
    const logger = silentLogger()
    const { fetchFn } = fakeFetch((url) =>
      url.hostname === 'fonts.googleapis.com' ? new Response(dmSansCss) : new Response('gone', { status: 500 }),
    )
    const fonts = createBrandingFonts(branding({ 'font-sans': 'DM Sans' }), { fetchFn, logger })
    await fonts.load()

    expect(fonts.faces()).toEqual([])
    expect(logger.entries).toEqual([expect.objectContaining({ level: 'warn' })])
  })

  it('skips generic families and loads each named family once', async () => {
    const { fetchFn, requests } = fakeFetch(
      (url) => (url.hostname === 'fonts.googleapis.com' ? new Response(dmSansCss) : undefined),
      fontFiles,
    )
    const fonts = createBrandingFonts(
      branding({
        'font-sans': 'DM Sans, sans-serif',
        'font-heading': 'DM Sans',
        'font-mono': 'ui-monospace, monospace',
      }),
      { fetchFn, logger: silentLogger() },
    )
    await fonts.load()

    expect(requests.filter((url) => url.includes('googleapis'))).toHaveLength(1)
  })

  it('ignores font files hosted anywhere but Google', async () => {
    const { fetchFn } = fakeFetch(
      (url) =>
        url.hostname === 'fonts.googleapis.com'
          ? new Response(dmSansCss.replaceAll('https://fonts.gstatic.com/', 'https://evil.example/'))
          : undefined,
      fontFiles,
    )
    const fonts = createBrandingFonts(branding({ 'font-sans': 'DM Sans' }), { fetchFn, logger: silentLogger() })
    await fonts.load()

    expect(fonts.faces()).toEqual([])
  })

  it("treats Google's lookalike for a system font as not hosted, leaving the device's own", async () => {
    const logger = silentLogger()
    const georgiaLookalike = dmSansCss
      .replaceAll('DM Sans', 'Georgia')
      .replace(
        /https:\/\/fonts\.gstatic\.com\/s\/dmsans\/[\w-]+\.woff2/g,
        'https://fonts.gstatic.com/l/font?kit=abc&v=v18',
      )
    const { fetchFn, requests } = fakeFetch(
      (url) => (url.hostname === 'fonts.googleapis.com' ? new Response(georgiaLookalike) : undefined),
      fontFiles,
    )
    const fonts = createBrandingFonts(branding({ 'font-serif': 'Georgia, serif' }), { fetchFn, logger })
    await fonts.load()

    expect(fonts.faces()).toEqual([])
    expect(requests.some((url) => url.includes('gstatic'))).toBe(false)
    expect(logger.entries).toEqual([expect.objectContaining({ level: 'info', context: { family: 'Georgia' } })])
  })

  it('does nothing without branding fonts', async () => {
    const { fetchFn, requests } = fakeFetch()
    const fonts = createBrandingFonts(undefined, { fetchFn, logger: silentLogger() })
    await fonts.load()

    expect(requests).toEqual([])
  })
})
