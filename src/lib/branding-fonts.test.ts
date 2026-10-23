/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { HttpClient, ResponsePromise } from '@/lib/http'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { syncBrandingFonts } from './branding-fonts'

// The test DOM has no font loading API; these stand-ins record what the module does.
class FakeFontFace {
  constructor(
    readonly family: string,
    readonly source: ArrayBuffer,
    readonly descriptors: FontFaceDescriptors,
  ) {}
}

const fontSet = new Set<FakeFontFace>()
const original = { FontFace: globalThis.FontFace, fonts: Object.getOwnPropertyDescriptor(document, 'fonts') }

const face = (file: string, overrides: Record<string, unknown> = {}) => ({
  family: 'DM Sans',
  style: 'normal',
  weight: '100 900',
  unicodeRange: 'U+0000-00FF',
  file,
  ...overrides,
})

const fileA = 'aaaaaaaaaaaaaaaa.woff2'
const fileB = 'bbbbbbbbbbbbbbbb.woff2'

/** A client serving each requested path's own name as the font bytes, failing paths in `failing`. */
const fakeClient = (failing: Set<string> = new Set()) => {
  const requests: string[] = []
  const client = {
    get: (url: string) => {
      requests.push(url)
      const response = failing.has(url)
        ? Promise.reject(new Error('offline'))
        : Promise.resolve(new Response(new TextEncoder().encode(url)))
      return response as ResponsePromise
    },
  } as HttpClient
  return { client, requests }
}

describe('syncBrandingFonts', () => {
  beforeEach(() => {
    globalThis.FontFace = FakeFontFace as unknown as typeof FontFace
    Object.defineProperty(document, 'fonts', { configurable: true, value: fontSet })
  })

  afterEach(async () => {
    await syncBrandingFonts([], fakeClient().client)
    fontSet.clear()
    globalThis.FontFace = original.FontFace
    if (original.fonts) {
      Object.defineProperty(document, 'fonts', original.fonts)
    } else {
      Reflect.deleteProperty(document, 'fonts')
    }
  })

  it('registers each face from its downloaded bytes, with its descriptors', async () => {
    const { client, requests } = fakeClient()
    await syncBrandingFonts([face(fileA), face(fileB, { style: 'italic', weight: '400' })], client)

    expect(requests).toEqual([`config/fonts/${fileA}`, `config/fonts/${fileB}`])
    const registered = [...fontSet]
    expect(registered).toHaveLength(2)
    expect(registered[0].family).toBe('DM Sans')
    expect(new TextDecoder().decode(registered[0].source)).toBe(`config/fonts/${fileA}`)
    expect(registered[1].descriptors).toEqual({
      style: 'italic',
      weight: '400',
      unicodeRange: 'U+0000-00FF',
      display: 'swap',
    })
  })

  it('skips malformed entries rather than requesting them', async () => {
    const { client, requests } = fakeClient()
    await syncBrandingFonts([face('../etc/passwd'), face(fileA, { family: 'X; }' }), face(fileB)], client)

    expect(requests).toEqual([`config/fonts/${fileB}`])
  })

  it('registers a face once across overlapping syncs', async () => {
    const { client, requests } = fakeClient()
    await Promise.all([syncBrandingFonts([face(fileA)], client), syncBrandingFonts([face(fileA)], client)])

    expect(requests).toHaveLength(1)
    expect(fontSet.size).toBe(1)
  })

  it('removes faces the config no longer lists', async () => {
    const { client } = fakeClient()
    await syncBrandingFonts([face(fileA), face(fileB)], client)
    await syncBrandingFonts([face(fileB)], client)
    await Promise.resolve()

    expect([...fontSet].map((fontFace) => new TextDecoder().decode(fontFace.source))).toEqual([`config/fonts/${fileB}`])
  })

  it('forgets a failed download so the next sync retries it', async () => {
    const failing = fakeClient(new Set([`config/fonts/${fileA}`]))
    await expect(syncBrandingFonts([face(fileA)], failing.client)).rejects.toThrow('offline')

    const healthy = fakeClient()
    await syncBrandingFonts([face(fileA)], healthy.client)
    expect(healthy.requests).toEqual([`config/fonts/${fileA}`])
    expect(fontSet.size).toBe(1)
  })
})
