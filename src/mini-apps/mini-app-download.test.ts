/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it, spyOn } from 'bun:test'
import { maxMiniAppDownloadBytes, prepareMiniAppDownload, safeFileName, utf8ByteLength } from './mini-app-download'

/** A `ui/download-file` params object carrying one embedded resource. */
const params = (resource: Record<string, unknown>) => ({ contents: [{ type: 'resource', resource }] })

const toBase64 = (bytes: number[]) => btoa(String.fromCharCode(...bytes))

describe('prepareMiniAppDownload', () => {
  it('saves base64 content as bytes, named from the URI', () => {
    const prepared = prepareMiniAppDownload(
      params({ uri: 'file:///Q3%20report.pdf', mimeType: 'application/pdf', blob: toBase64([37, 80]) }),
    )

    expect(prepared).toEqual({
      ok: true,
      download: { name: 'Q3 report.pdf', contents: new Uint8Array([37, 80]), mimeType: 'application/pdf' },
    })
  })

  it('saves text content as text', () => {
    const prepared = prepareMiniAppDownload(params({ uri: 'file:///export.csv', text: 'a,b\n1,2' }))

    expect(prepared).toEqual({ ok: true, download: { name: 'export.csv', contents: 'a,b\n1,2', mimeType: 'text/csv' } })
  })

  /** The extension decides what opening the file does, so it decides the type too. */
  it('saves under the type the extension implies, not the one declared', () => {
    const prepared = prepareMiniAppDownload(params({ uri: 'file:///report.pdf', mimeType: 'text/html', text: 'x' }))

    expect(prepared.ok && prepared.download.mimeType).toBe('application/pdf')
  })

  it('takes the extension from the declared type when the name has none', () => {
    const prepared = prepareMiniAppDownload(params({ uri: 'file:///report', mimeType: 'application/pdf', text: 'x' }))

    expect(prepared.ok && prepared.download.name).toBe('report.pdf')
  })

  it.each([
    ['file:///setup.exe', '.exe files are'],
    ['file:///page.html', '.html files are'],
    ['file:///icon.svg', '.svg files are'],
    ['file:///deck.pptx', '.pptx files are'],
    ['file:///report', 'a file with no extension is'],
  ])('refuses %s', (uri, refused) => {
    expect(prepareMiniAppDownload(params({ uri, text: 'x' }))).toEqual({
      ok: false,
      message: `Policy violation: ${refused} not saved`,
    })
  })

  it('refuses a file over the size cap, before decoding it', () => {
    // Not valid base64: decoding first would answer "not base64" instead.
    const blob = `${'A'.repeat(Math.ceil((maxMiniAppDownloadBytes * 4) / 3) + 8)}!`

    expect(prepareMiniAppDownload(params({ uri: 'file:///big.pdf', blob }))).toEqual({
      ok: false,
      message: 'Policy violation: files over 50 MB are not saved',
    })
  })

  it('refuses text over the size cap without encoding it', () => {
    const encode = spyOn(TextEncoder.prototype, 'encode')
    try {
      const text = 'a'.repeat(maxMiniAppDownloadBytes + 1)

      expect(prepareMiniAppDownload(params({ uri: 'file:///notes.txt', text }))).toEqual({
        ok: false,
        message: 'Policy violation: files over 50 MB are not saved',
      })
      expect(encode.mock.calls.some(([input]) => input === text)).toBe(false)
    } finally {
      encode.mockRestore()
    }
  })

  it('measures text in bytes, not characters, without encoding it', () => {
    const encode = spyOn(TextEncoder.prototype, 'encode')
    try {
      // Three bytes each in UTF-8, so this is over the cap while its length is not.
      const text = '€'.repeat(Math.floor(maxMiniAppDownloadBytes / 3) + 1)

      expect(prepareMiniAppDownload(params({ uri: 'file:///notes.txt', text })).ok).toBe(false)
      expect(encode.mock.calls.some(([input]) => input === text)).toBe(false)
    } finally {
      encode.mockRestore()
    }
  })

  /** Bounded before the name is parsed: a long run of dots made the trimming quadratic and froze the host. */
  it('refuses an overlong uri without parsing it', () => {
    const uri = `file:///${'.'.repeat(1_000_000)}x.pdf`

    expect(prepareMiniAppDownload(params({ uri, text: 'x' }))).toEqual({
      ok: false,
      message: 'Invalid content: the resource uri is too long',
    })
  })

  it('refuses a blob that is not base64', () => {
    expect(prepareMiniAppDownload(params({ uri: 'file:///report.pdf', blob: 'not base64!' }))).toEqual({
      ok: false,
      message: 'Invalid content: blob is not base64',
    })
  })

  it('refuses a resource with both text and blob, or neither', () => {
    const both = prepareMiniAppDownload(params({ uri: 'file:///a.txt', text: 'x', blob: toBase64([1]) }))
    const neither = prepareMiniAppDownload(params({ uri: 'file:///a.txt' }))

    expect(both).toEqual({ ok: false, message: 'Invalid content: the resource needs either text or blob' })
    expect(neither).toEqual(both)
  })

  /** One file per request; a link the host would have to fetch is not supported. */
  it.each([
    ['no contents', {}],
    [
      'two files',
      { contents: [params({ uri: 'a.txt', text: 'x' }).contents[0], params({ uri: 'b.txt', text: 'y' }).contents[0]] },
    ],
    ['a resource link', { contents: [{ type: 'resource_link', uri: 'https://example.test/q4.pdf', name: 'Q4' }] }],
  ])('refuses %s', (_label, value) => {
    expect(prepareMiniAppDownload(value)).toEqual({
      ok: false,
      message: 'Invalid content: send exactly one embedded resource',
    })
  })
})

describe('safeFileName', () => {
  it('keeps an ordinary name as it is, lowercasing the extension', () => {
    expect(safeFileName('Q3 Report.PDF')).toEqual({ stem: 'Q3 Report', extension: 'pdf' })
  })

  /** A decoded `%2F` must not become a directory. */
  it('strips path separators and characters filesystems reject', () => {
    expect(safeFileName('../../etc/pass:wd?.txt')).toEqual({ stem: 'etc pass wd', extension: 'txt' })
    expect(safeFileName('a\\b<c>d|e*f"g.txt')).toEqual({ stem: 'a b c d e f g', extension: 'txt' })
  })

  it('does not create a hidden file', () => {
    expect(safeFileName('.profile.txt')).toEqual({ stem: 'profile', extension: 'txt' })
  })

  it('removes control characters, C0 and C1', () => {
    expect(safeFileName('re\u0000po\u001frt\u0085.pdf')).toEqual({ stem: 're po rt', extension: 'pdf' })
  })

  /** A right-to-left override would reverse the prompt's own sentence around the name. */
  it('removes invisible format characters', () => {
    expect(safeFileName('invoice\u202Efdp.txt')).toEqual({ stem: 'invoice fdp', extension: 'txt' })
    expect(safeFileName('a\u200Bb.txt')).toEqual({ stem: 'a b', extension: 'txt' })
  })

  it.each([
    ['CON.pdf', '_CON'],
    ['aux.notes.pdf', '_aux.notes'],
    ['COM0.pdf', '_COM0'],
    ['lpt¹.pdf', '_lpt¹'],
  ])('renames the Windows device name %s, which cannot be created even with an extension', (name, stem) => {
    expect(safeFileName(name)).toEqual({ stem, extension: 'pdf' })
  })

  it('leaves a name that merely starts like a device name alone', () => {
    expect(safeFileName('console log.txt')).toEqual({ stem: 'console log', extension: 'txt' })
  })

  it('falls back to a name when nothing usable is left', () => {
    expect(safeFileName('///.pdf')).toEqual({ stem: 'download', extension: 'pdf' })
    expect(safeFileName('?.pdf')).toEqual({ stem: 'download', extension: 'pdf' })
    expect(safeFileName('')).toEqual({ stem: 'download', extension: '' })
  })

  it('drops trailing dots and spaces before finding the extension', () => {
    expect(safeFileName('report.pdf. ')).toEqual({ stem: 'report', extension: 'pdf' })
  })

  /** Bytes, not characters: filesystems cap a name at 255 bytes and CJK takes three each. */
  it('bounds the stem to 200 UTF-8 bytes without splitting a character', () => {
    expect(safeFileName(`${'😀'.repeat(200)}.pdf`).stem).toBe('😀'.repeat(50))
    expect(safeFileName(`${'漢'.repeat(120)}.pdf`).stem).toBe('漢'.repeat(66))
  })
})

describe('utf8ByteLength', () => {
  it.each([
    ['empty', ''],
    ['ASCII', 'a,b\n1,2'],
    ['two-byte', 'café'],
    ['three-byte', '€ and 漢字'],
    ['a surrogate pair', 'chart 📈 up'],
    ['a lone high surrogate', 'a\ud800b'],
    ['a lone low surrogate', 'a\udc00b'],
    ['a high surrogate at the end', 'abc\ud800'],
  ])('agrees with TextEncoder on %s', (_label, text) => {
    expect(utf8ByteLength(text)).toBe(new TextEncoder().encode(text).byteLength)
  })
})
