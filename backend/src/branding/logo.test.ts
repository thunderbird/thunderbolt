/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { fakeFetch, imageResponse, routeFor } from '@/test-utils/branding'
import { parsePublicBranding } from '@shared/branding'
import { describe, expect, it } from 'bun:test'
import { isRetryable, PermanentDownloadError } from './download'
import { downloadLogo } from './logo'

const url = 'https://acme.test/logo.svg'

describe('downloadLogo', () => {
  it('downloads an image and names it by its content and type', async () => {
    const { fetchFn } = fakeFetch(routeFor(url, imageResponse('<svg>acme</svg>', 'image/svg+xml; charset=utf-8')))

    const { logo, file } = await downloadLogo(url, fetchFn)

    expect(logo.type).toBe('image/svg+xml')
    // The name the client checks before requesting it.
    expect(parsePublicBranding({ logo: { light: logo } }).branding).toEqual({ logo: { light: logo } })
    expect(file).toMatchObject({ name: logo.file, type: 'image/svg+xml' })
    expect(new TextDecoder().decode(file.bytes)).toBe('<svg>acme</svg>')
  })

  it('rejects a type email clients and the client cannot both trust', async () => {
    const { fetchFn } = fakeFetch(routeFor(url, imageResponse('<html>', 'text/html')))

    await expect(downloadLogo(url, fetchFn)).rejects.toThrow('Logo must be SVG, PNG, WebP or JPEG; got "text/html"')
  })

  it('rejects a 404 as permanent and a 503 as retryable', async () => {
    const missing = fakeFetch(routeFor(url, () => new Response('gone', { status: 404 })))
    await expect(downloadLogo(url, missing.fetchFn)).rejects.toBeInstanceOf(PermanentDownloadError)

    const busy = fakeFetch(routeFor(url, () => new Response('busy', { status: 503 })))
    const error = await downloadLogo(url, busy.fetchFn).catch((thrown: unknown) => thrown)
    expect(isRetryable(error)).toBe(true)
  })

  it('rejects an empty file', async () => {
    const { fetchFn } = fakeFetch(routeFor(url, imageResponse('', 'image/png')))

    await expect(downloadLogo(url, fetchFn)).rejects.toThrow('Logo is empty')
  })

  it('rejects a file over the size limit', async () => {
    const { fetchFn } = fakeFetch(routeFor(url, imageResponse('x'.repeat(512 * 1024 + 1), 'image/png')))

    await expect(downloadLogo(url, fetchFn)).rejects.toThrow('larger than the 524288-byte limit')
  })
})
