/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { createRecordingClient } from '@/test-utils/http-client'
import type { BrandingFontFace } from '@shared/branding'
import { afterEach, describe, expect, it, mock, spyOn } from 'bun:test'
import { createFontSync, type FontRegistry } from './branding-fonts'

type Registered = { face: BrandingFontFace; source: string }

/** A registry recording what is registered, standing in for `document.fonts`. */
const fakeRegistry = () => {
  const registered = new Set<Registered>()
  const registry: FontRegistry<Registered> = {
    add: (face, bytes) => {
      const entry = { face, source: new TextDecoder().decode(bytes) }
      registered.add(entry)
      return entry
    },
    remove: (entry) => registered.delete(entry),
  }
  return { registry, registered }
}

/** A backend answering each path with its own name as the bytes, failing paths in `failing`. */
const backend = (failing: Set<string> = new Set()) =>
  createRecordingClient((path) => (failing.has(path) ? undefined : new TextEncoder().encode(path)))

const face = (file: string, overrides: Partial<BrandingFontFace> = {}): BrandingFontFace => ({
  family: 'DM Sans',
  style: 'normal',
  weight: '100 900',
  unicodeRange: 'U+0000-00FF',
  file,
  ...overrides,
})

const fileA = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.woff2'
const fileB = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb.woff2'

describe('createFontSync', () => {
  afterEach(() => {
    mock.restore()
  })

  it('registers each face from its downloaded bytes', async () => {
    const { registry, registered } = fakeRegistry()
    const { client, requests } = backend()
    await createFontSync(registry)([face(fileA), face(fileB, { style: 'italic', weight: '400' })], client)

    expect(requests).toEqual([`config/branding/${fileA}`, `config/branding/${fileB}`])
    const [first, second] = [...registered]
    expect(first.source).toBe(`config/branding/${fileA}`)
    expect(second.face).toMatchObject({ style: 'italic', weight: '400' })
  })

  it('registers a face once across overlapping syncs', async () => {
    const { registry, registered } = fakeRegistry()
    const { client, requests } = backend()
    const sync = createFontSync(registry)
    await Promise.all([sync([face(fileA)], client), sync([face(fileA)], client)])

    expect(requests).toHaveLength(1)
    expect(registered.size).toBe(1)
  })

  it('removes faces the config no longer lists', async () => {
    const { registry, registered } = fakeRegistry()
    const { client } = backend()
    const sync = createFontSync(registry)
    await sync([face(fileA), face(fileB)], client)
    await sync([face(fileB)], client)

    expect([...registered].map(({ source }) => source)).toEqual([`config/branding/${fileB}`])
  })

  it('tracks faces that share a file separately, so dropping the family removes both', async () => {
    const { registry, registered } = fakeRegistry()
    const { client } = backend()
    const sync = createFontSync(registry)
    await sync([face(fileA, { weight: '400' }), face(fileA, { weight: '700' })], client)
    expect(registered.size).toBe(2)

    await sync([], client)
    expect(registered.size).toBe(0)
  })

  it('logs a failed download instead of rejecting, and retries it on the next sync', async () => {
    const warn = spyOn(console, 'warn').mockImplementation(() => {})
    const { registry, registered } = fakeRegistry()
    const sync = createFontSync(registry)
    const failing = backend(new Set([`config/branding/${fileA}`]))
    await sync([face(fileA)], failing.client)
    expect(warn).toHaveBeenCalled()
    expect(registered.size).toBe(0)

    const healthy = backend()
    await sync([face(fileA)], healthy.client)
    expect(healthy.requests).toEqual([`config/branding/${fileA}`])
    expect(registered.size).toBe(1)
  })

  it('removes a face dropped while its download is still in flight, once it lands', async () => {
    const { registry, registered } = fakeRegistry()
    const { client } = backend()
    const sync = createFontSync(registry)
    const first = sync([face(fileA)], client)
    await sync([], client)
    await first

    expect(registered.size).toBe(0)
  })

  it('removes everything when branding lists no fonts', async () => {
    const { registry, registered } = fakeRegistry()
    const { client } = backend()
    const sync = createFontSync(registry)
    await sync([face(fileA)], client)
    await sync(undefined, client)

    expect(registered.size).toBe(0)
  })
})
