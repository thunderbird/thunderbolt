/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { fakeFetch, type FakeRoute } from '@/test-utils/branding'
import { isBrandingFontFace, type Branding } from '@shared/branding'
import { describe, expect, it } from 'bun:test'
import { isRetryable } from './download'
import { downloadFontFamily, familiesToLoad, parseGoogleFontsCss } from './fonts'

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

const fontFiles: FakeRoute = (url) =>
  url.hostname === 'fonts.gstatic.com' ? new Response(new TextEncoder().encode(url.pathname)) : undefined

const googleCss =
  (css: string, when: (url: URL) => boolean = () => true): FakeRoute =>
  (url) =>
    url.hostname === 'fonts.googleapis.com' && when(url) ? new Response(css) : undefined

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

describe('downloadFontFamily', () => {
  it('downloads a variable font, naming each file by its content', async () => {
    const { fetchFn } = fakeFetch(googleCss(dmSansCss), fontFiles)

    const downloaded = await downloadFontFamily('DM Sans', fetchFn)

    expect(downloaded?.faces).toHaveLength(2)
    expect(downloaded?.faces[0]).toMatchObject({ family: 'DM Sans', style: 'normal', weight: '100 900' })
    // The name the client checks before requesting it.
    expect(downloaded?.faces.every(isBrandingFontFace)).toBe(true)
    expect(downloaded?.files[0]).toMatchObject({ name: downloaded?.faces[0].file, type: 'font/woff2' })
    expect(new TextDecoder().decode(downloaded?.files[0].bytes)).toBe('/s/dmsans/latin-ext.woff2')
  })

  it('retries a font file Google no longer serves, since the retry fetches fresh URLs', async () => {
    const gone: FakeRoute = (url) =>
      url.hostname === 'fonts.gstatic.com' ? new Response('', { status: 404 }) : undefined
    const { fetchFn } = fakeFetch(googleCss(dmSansCss), gone)

    const error = await downloadFontFamily('DM Sans', fetchFn).catch((thrown: unknown) => thrown)

    expect(error).toBeInstanceOf(Error)
    expect(isRetryable(error)).toBe(true)
  })

  it('retries a stylesheet over the size cap, since Google rather than BRANDING sent it', async () => {
    const huge = new Response('/* latin */ @font-face {}', { headers: { 'content-length': String(1024 * 1024) } })
    const { fetchFn } = fakeFetch((url) => (url.hostname === 'fonts.googleapis.com' ? huge : undefined))

    const error = await downloadFontFamily('DM Sans', fetchFn).catch((thrown: unknown) => thrown)

    expect(error).toBeInstanceOf(Error)
    expect(isRetryable(error)).toBe(true)
  })

  it('falls back to static weights when Google rejects the variable range', async () => {
    const { fetchFn, requests } = fakeFetch(
      googleCss(dmSansCss.replaceAll('DM Sans', 'Space Mono'), (url) => url.search.includes('0,400;0,700')),
      fontFiles,
    )

    const downloaded = await downloadFontFamily('Space Mono', fetchFn)

    expect(requests[0]).toContain('family=Space+Mono:ital,wght@0,100..900')
    expect(downloaded?.faces.map((face) => face.family)).toEqual(['Space Mono', 'Space Mono'])
  })

  it('reports a family Google answers 400 for as not hosted', async () => {
    const { fetchFn } = fakeFetch()

    expect(await downloadFontFamily('Georgia', fetchFn)).toBeNull()
  })

  it('throws on a Google outage rather than calling the family not hosted', async () => {
    const { fetchFn } = fakeFetch(() => new Response('busy', { status: 503 }))

    await expect(downloadFontFamily('DM Sans', fetchFn)).rejects.toThrow('Google Fonts answered 503')
  })

  it('throws when a font file fails, so the family is never half-served', async () => {
    const { fetchFn } = fakeFetch(googleCss(dmSansCss), () => new Response('gone', { status: 500 }))

    await expect(downloadFontFamily('DM Sans', fetchFn)).rejects.toThrow('Request failed with 500')
  })

  it('throws on a 200 that carries no font faces, so it is retried rather than called not hosted', async () => {
    const { fetchFn } = fakeFetch(() => new Response('<html>Too many requests</html>'))

    await expect(downloadFontFamily('DM Sans', fetchFn)).rejects.toThrow('without any font faces')
  })

  it('ignores font files hosted anywhere but Google', async () => {
    const { fetchFn } = fakeFetch(
      googleCss(dmSansCss.replaceAll('https://fonts.gstatic.com/', 'https://evil.example/')),
      fontFiles,
    )

    expect(await downloadFontFamily('DM Sans', fetchFn)).toBeNull()
  })

  it("treats Google's lookalike for a system font as not hosted, leaving the device's own", async () => {
    const georgiaLookalike = dmSansCss
      .replaceAll('DM Sans', 'Georgia')
      .replace(
        /https:\/\/fonts\.gstatic\.com\/s\/dmsans\/[\w-]+\.woff2/g,
        'https://fonts.gstatic.com/l/font?kit=abc&v=v18',
      )
    const { fetchFn, requests } = fakeFetch(googleCss(georgiaLookalike), fontFiles)

    expect(await downloadFontFamily('Georgia', fetchFn)).toBeNull()
    expect(requests.some((url) => url.includes('gstatic'))).toBe(false)
  })
})

describe('familiesToLoad', () => {
  it('takes the first named family per slot, once each, skipping generics', () => {
    expect(
      familiesToLoad(
        branding({
          'font-sans': 'DM Sans, sans-serif',
          'font-heading': 'DM Sans',
          'font-mono': 'ui-monospace, monospace',
        }),
      ),
    ).toEqual(['DM Sans'])
  })

  it('is empty without branding', () => {
    expect(familiesToLoad(undefined)).toEqual([])
  })
})
