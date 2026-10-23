/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { fontFamiliesBySlot, isGenericFontFamily, type Branding, type BrandingFontFace } from '@shared/branding'
import {
  contentName,
  fetchOk,
  PermanentDownloadError,
  readCapped,
  requestTimeoutMs,
  type BrandingFetch,
  type BrandingFile,
} from './download'

const googleFontsCssUrl = 'https://fonts.googleapis.com/css2'
// Real Google Fonts files live under /s/<family>/. For a name it doesn't host
// (Georgia, Times New Roman) Google answers 200 with a lookalike under
// /l/font?kit=…, labeled with the requested name; taking it would replace the
// genuine font on every device that has it.
const googleFontsFilePrefix = 'https://fonts.gstatic.com/s/'

// Google serves woff2 only to user agents it recognizes as modern browsers.
const userAgent =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36'

// Google rejects a weight range on a static font and any weight a font lacks,
// so try the variable range first, then the common static cuts, then regular.
const axisQueries = ['ital,wght@0,100..900;1,100..900', 'ital,wght@0,400;0,700;1,400;1,700', 'wght@400;700', 'wght@400']

// Latin-script subsets only. Other scripts fall back to the system fonts the
// client appends to every list (CJK already does), which keeps every face a
// client must download up front to a handful of small files.
const keptSubsets = new Set(['latin', 'latin-ext'])

// Caps on what Google sends back: a Latin woff2 is tens of KB and a css2
// stylesheet a few KB, so these only stop a runaway response.
const maxFontFileBytes = 2 * 1024 * 1024
const maxCssBytes = 256 * 1024

type ParsedFace = Omit<BrandingFontFace, 'file'> & { url: string }

/**
 * The faces in a Google Fonts css2 response, keeping only `keptSubsets`.
 * Google labels each `@font-face` block with a `/* subset *\/` comment.
 *
 * @param css - The stylesheet Google returned.
 */
export const parseGoogleFontsCss = (css: string): ParsedFace[] =>
  [...css.matchAll(/\/\*\s*([\w-]+)\s*\*\/\s*@font-face\s*\{([^}]*)\}/g)].flatMap(([, subset, body]) => {
    const field = (name: string) => body.match(new RegExp(`${name}:\\s*([^;]+);`))?.[1].trim()
    const url = body.match(/src:\s*url\(([^)]+)\)/)?.[1]
    const family = field('font-family')?.replace(/^'|'$/g, '')
    const style = field('font-style')
    const weight = field('font-weight')
    const unicodeRange = field('unicode-range')
    if (!keptSubsets.has(subset) || !url || !family || !weight || !unicodeRange) {
      return []
    }
    if (style !== 'normal' && style !== 'italic') {
      return []
    }
    return [{ family, style, weight, unicodeRange, url }]
  })

/**
 * The first non-generic name in each font slot: the one the operator means to load.
 *
 * @param branding - Validated branding.
 */
export const familiesToLoad = (branding: Branding | undefined): string[] => {
  const names = Object.values(fontFamiliesBySlot(branding)).flatMap((list) => {
    const first = list.find((name) => !isGenericFontFamily(name))
    return first ? [first] : []
  })
  return [...new Set(names)]
}

// What Google serves isn't the operator's configuration, so even a final
// failure on it (a file Google has since replaced, an oversized stylesheet) is
// worth a retry, which fetches the stylesheet, and its URLs, afresh.
const asRetryable = (error: unknown) =>
  error instanceof PermanentDownloadError ? new Error(error.message, { cause: error }) : error

const readCss = async (response: Response) => {
  try {
    return new TextDecoder().decode(await readCapped(response, maxCssBytes))
  } catch (error) {
    throw asRetryable(error)
  }
}

// Google answers 400 both for a family it doesn't host and for axes a family
// lacks; anything else that isn't ok is an outage, worth a retry.
const fetchCss = async (family: string, fetchFn: BrandingFetch): Promise<string | null> => {
  for (const axes of axisQueries) {
    const url = `${googleFontsCssUrl}?family=${encodeURIComponent(family).replace(/%20/g, '+')}:${axes}&display=swap`
    const response = await fetchFn(url, {
      headers: { 'User-Agent': userAgent },
      signal: AbortSignal.timeout(requestTimeoutMs),
    })
    if (response.ok) {
      const css = await readCss(response)
      // A 200 without a single face isn't Google's stylesheet (an interstitial, a changed format): retry it.
      if (!css.includes('@font-face')) {
        throw new Error('Google Fonts answered without any font faces')
      }
      return css
    }
    await response.body?.cancel()
    if (response.status !== 400) {
      throw new Error(`Google Fonts answered ${response.status}`)
    }
  }
  return null
}

const downloadFontFile = async (url: string, fetchFn: BrandingFetch) => {
  try {
    return await readCapped(await fetchOk(url, fetchFn), maxFontFileBytes)
  } catch (error) {
    throw asRetryable(error)
  }
}

/**
 * Download one family's Latin faces from Google Fonts, in full before
 * returning, so a family is served whole or not at all.
 *
 * @param family - A family name from the operator's font tokens.
 * @param fetchFn - The fetch to download with.
 * @returns The faces and their files, or null when Google doesn't host the
 *   family (Georgia, Helvetica): it is assumed installed on users' devices.
 * @throws When Google or a file request fails; see `isRetryable` for which the caller retries.
 */
export const downloadFontFamily = async (
  family: string,
  fetchFn: BrandingFetch,
): Promise<{ faces: BrandingFontFace[]; files: BrandingFile[] } | null> => {
  const css = await fetchCss(family, fetchFn)
  if (!css) {
    return null
  }
  const parsed = parseGoogleFontsCss(css).filter((face) => face.url.startsWith(googleFontsFilePrefix))
  if (parsed.length === 0) {
    return null
  }
  const downloaded = await Promise.all(
    parsed.map(async ({ url, ...face }) => {
      const bytes = await downloadFontFile(url, fetchFn)
      const name = await contentName(bytes, 'woff2')
      return { face: { ...face, file: name }, file: { name, bytes, type: 'font/woff2' } }
    }),
  )
  return { faces: downloaded.map(({ face }) => face), files: downloaded.map(({ file }) => file) }
}
