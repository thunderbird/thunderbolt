/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { brandingFontFamilies, isGenericFontFamily, type Branding, type BrandingFontFace } from '@shared/branding'

const googleFontsCssUrl = 'https://fonts.googleapis.com/css2'
// Real Google Fonts files live under /s/<family>/. For a name it doesn't host
// (Georgia, Times New Roman) Google answers 200 with a lookalike under
// /l/font?kit=…, labelled with the requested name; taking it would replace the
// genuine font on every device that has it.
const googleFontsFilePrefix = 'https://fonts.gstatic.com/s/'
const requestTimeoutMs = 10_000

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

export type BrandingFontsLogger = {
  info: (context: Record<string, unknown>, message: string) => void
  warn: (context: Record<string, unknown>, message: string) => void
}

export type BrandingFonts = {
  /** Faces resolved so far; empty until `load` finishes, or when nothing resolved. */
  faces: () => BrandingFontFace[]
  /** A served font file by its content-addressed name. */
  file: (name: string) => Uint8Array<ArrayBuffer> | undefined
  /** Downloads every named font; resolves once all attempts finish, never rejects. */
  load: () => Promise<void>
}

/** Serves nothing: what an app gets when nothing downloaded fonts for it. */
export const noBrandingFonts: Pick<BrandingFonts, 'faces' | 'file'> = { faces: () => [], file: () => undefined }

type ParsedFace = Omit<BrandingFontFace, 'file'> & { url: string }

/**
 * The faces in a Google Fonts css2 response, keeping only `keptSubsets`.
 * Google labels each `@font-face` block with a `/* subset *\/` comment.
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

/** The first non-generic name in each font slot: the one the operator means to load. */
const familiesToLoad = (branding: Branding | undefined): string[] => {
  const names = Object.values(brandingFontFamilies(branding)).flatMap((list) => {
    const first = list.find((name) => !isGenericFontFamily(name))
    return first ? [first] : []
  })
  return [...new Set(names)]
}

const contentName = async (bytes: Uint8Array<ArrayBuffer>): Promise<string> => {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))
  const hex = [...digest.slice(0, 16)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
  return `${hex}.woff2`
}

/**
 * Downloads the operator's fonts from Google Fonts once, at startup, and holds
 * the files in memory for `GET /config/fonts/:file`. Users' browsers only ever
 * talk to this backend, so Google sees the server, never a user.
 *
 * A family Google doesn't have is assumed to be installed on users' devices
 * (Georgia, Helvetica) and is left to the browser. Fonts are cosmetic, so a
 * failure is logged rather than fatal; the app keeps its system fonts until
 * the next restart.
 */
export const createBrandingFonts = (
  branding: Branding | undefined,
  options: { fetchFn?: typeof fetch; logger: BrandingFontsLogger },
): BrandingFonts => {
  const fetchFn = options.fetchFn ?? globalThis.fetch
  const files = new Map<string, Uint8Array<ArrayBuffer>>()
  const resolved: BrandingFontFace[] = []

  const fetchCss = async (family: string): Promise<string | null> => {
    for (const axes of axisQueries) {
      const url = `${googleFontsCssUrl}?family=${encodeURIComponent(family).replace(/%20/g, '+')}:${axes}&display=swap`
      const response = await fetchFn(url, {
        headers: { 'User-Agent': userAgent },
        signal: AbortSignal.timeout(requestTimeoutMs),
      })
      if (response.ok) {
        return response.text()
      }
      await response.arrayBuffer()
    }
    return null
  }

  const loadFamily = async (family: string) => {
    const css = await fetchCss(family)
    const faces = css ? parseGoogleFontsCss(css).filter((face) => face.url.startsWith(googleFontsFilePrefix)) : []
    if (faces.length === 0) {
      options.logger.info({ family }, 'Branding font not on Google Fonts; assuming it is installed on devices')
      return
    }
    // Downloaded in full before anything is published, so a family is served whole or not at all.
    const downloaded = await Promise.all(
      faces.map(async ({ url, ...face }) => {
        const response = await fetchFn(url, { signal: AbortSignal.timeout(requestTimeoutMs) })
        if (!response.ok) {
          throw new Error(`Font file request failed with ${response.status}`)
        }
        const bytes = new Uint8Array(await response.arrayBuffer())
        return { face: { ...face, file: await contentName(bytes) }, bytes }
      }),
    )
    for (const { face, bytes } of downloaded) {
      files.set(face.file, bytes)
      resolved.push(face)
    }
    options.logger.info({ family, faces: faces.length }, 'Branding font loaded from Google Fonts')
  }

  return {
    faces: () => resolved,
    file: (name) => files.get(name),
    load: async () => {
      await Promise.all(
        familiesToLoad(branding).map((family) =>
          loadFamily(family).catch((error: unknown) =>
            options.logger.warn(
              { family, error: error instanceof Error ? error.message : String(error) },
              'Branding font could not be loaded; the app falls back to system fonts',
            ),
          ),
        ),
      )
    },
  }
}
