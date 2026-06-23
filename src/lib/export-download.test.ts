/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test'
import { getClock } from '@/testing-library'
import { downloadJson, exportFilenameFor } from './export-download'

describe('exportFilenameFor', () => {
  it('formats the filename as YYYY-MM-DD.json.gz in local time', () => {
    // Using local-TZ constructor so the test is timezone-independent —
    // whatever the runner's TZ is, getFullYear/getMonth/getDate match.
    const date = new Date(2026, 5, 16, 12, 34, 56)
    expect(exportFilenameFor(date)).toBe('thunderbolt-export-2026-06-16.json.gz')
  })

  it('zero-pads month and day', () => {
    const date = new Date(2026, 0, 3, 0, 0, 0)
    expect(exportFilenameFor(date)).toBe('thunderbolt-export-2026-01-03.json.gz')
  })

  it('reflects the local calendar day even on the UTC boundary', () => {
    // 23:30 on the 16th locally is still the 16th in the filename, regardless
    // of whether that's a different UTC day for the runner.
    const date = new Date(2026, 5, 16, 23, 30, 0)
    expect(exportFilenameFor(date)).toBe('thunderbolt-export-2026-06-16.json.gz')
  })
})

/** Reverse the gzip round-trip so the test can read back what `downloadJson` packed. */
const gunzipToJson = async (blob: Blob): Promise<unknown> => {
  const stream = blob.stream().pipeThrough(new DecompressionStream('gzip'))
  const text = await new Response(stream).text()
  return JSON.parse(text)
}

describe('downloadJson', () => {
  let createSpy: ReturnType<typeof spyOn>
  let revokeSpy: ReturnType<typeof spyOn>

  beforeEach(() => {
    createSpy = spyOn(URL, 'createObjectURL').mockImplementation(() => 'blob:test/abc-123')
    revokeSpy = spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined)
  })

  afterEach(() => {
    createSpy.mockRestore()
    revokeSpy.mockRestore()
  })

  it('clicks an anchor with download + href and removes it afterwards', async () => {
    const removeChildSpy = spyOn(document.body, 'removeChild')

    await downloadJson('export.json.gz', { hello: 'world' })

    expect(createSpy).toHaveBeenCalledTimes(1)
    const blob = createSpy.mock.calls[0]?.[0] as Blob
    expect(blob).toBeInstanceOf(Blob)
    expect(blob.type).toBe('application/gzip')
    // The anchor only lives for one tick — assert it was appended then removed.
    expect(removeChildSpy).toHaveBeenCalledTimes(1)

    removeChildSpy.mockRestore()
  })

  it('does NOT revoke the blob URL synchronously (WebKit cancels in-flight downloads otherwise)', async () => {
    await downloadJson('export.json.gz', { hello: 'world' })
    expect(revokeSpy).not.toHaveBeenCalled()
  })

  it('revokes the blob URL on the next macrotask', async () => {
    await downloadJson('export.json.gz', { hello: 'world' })
    await getClock().tickAsync(0)
    expect(revokeSpy).toHaveBeenCalledTimes(1)
    expect(revokeSpy).toHaveBeenCalledWith('blob:test/abc-123')
  })

  it('round-trips the payload through gzip → JSON', async () => {
    const payload = { hello: 'world', list: [1, 2, 3], nested: { a: true, b: null } }
    await downloadJson('export.json.gz', payload)
    const blob = createSpy.mock.calls[0]?.[0] as Blob
    expect(await gunzipToJson(blob)).toEqual(payload)
  })

  it('serializes without indentation (gzip is a poor fit for whitespace anyway)', async () => {
    await downloadJson('export.json.gz', { hello: 'world', list: [1, 2, 3] })
    const blob = createSpy.mock.calls[0]?.[0] as Blob
    const stream = blob.stream().pipeThrough(new DecompressionStream('gzip'))
    const text = await new Response(stream).text()
    expect(text).not.toContain('\n')
  })
})
