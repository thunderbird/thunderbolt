/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test'
import { getClock } from '@/testing-library'
import { downloadJson, exportFilenameFor } from './export-download'

describe('exportFilenameFor', () => {
  it('formats the filename as YYYY-MM-DD.json in local time', () => {
    // Using local-TZ constructor so the test is timezone-independent —
    // whatever the runner's TZ is, getFullYear/getMonth/getDate match.
    const date = new Date(2026, 5, 16, 12, 34, 56)
    expect(exportFilenameFor(date)).toBe('thunderbolt-export-2026-06-16.json')
  })

  it('zero-pads month and day', () => {
    const date = new Date(2026, 0, 3, 0, 0, 0)
    expect(exportFilenameFor(date)).toBe('thunderbolt-export-2026-01-03.json')
  })

  it('reflects the local calendar day even on the UTC boundary', () => {
    // 23:30 on the 16th locally is still the 16th in the filename, regardless
    // of whether that's a different UTC day for the runner.
    const date = new Date(2026, 5, 16, 23, 30, 0)
    expect(exportFilenameFor(date)).toBe('thunderbolt-export-2026-06-16.json')
  })
})

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

  it('clicks an anchor with download + href and removes it afterwards', () => {
    const removeChildSpy = spyOn(document.body, 'removeChild')

    downloadJson('export.json', { hello: 'world' })

    expect(createSpy).toHaveBeenCalledTimes(1)
    const blob = createSpy.mock.calls[0]?.[0] as Blob
    expect(blob).toBeInstanceOf(Blob)
    expect(blob.type).toBe('application/json')
    // The anchor only lives for one tick — assert it was appended then removed.
    expect(removeChildSpy).toHaveBeenCalledTimes(1)

    removeChildSpy.mockRestore()
  })

  it('does NOT revoke the blob URL synchronously (WebKit cancels in-flight downloads otherwise)', () => {
    downloadJson('export.json', { hello: 'world' })
    expect(revokeSpy).not.toHaveBeenCalled()
  })

  it('revokes the blob URL on the next macrotask', async () => {
    downloadJson('export.json', { hello: 'world' })
    await getClock().tickAsync(0)
    expect(revokeSpy).toHaveBeenCalledTimes(1)
    expect(revokeSpy).toHaveBeenCalledWith('blob:test/abc-123')
  })

  it('serializes the payload as JSON', async () => {
    const payload = { hello: 'world', list: [1, 2, 3], nested: { a: true, b: null } }
    downloadJson('export.json', payload)
    const blob = createSpy.mock.calls[0]?.[0] as Blob
    expect(JSON.parse(await blob.text())).toEqual(payload)
  })
})
