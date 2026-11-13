/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'bun:test'
import { safeFileName } from './safe-file-name'

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
    expect(safeFileName('invoice\u{202E}fdp.txt')).toEqual({ stem: 'invoice fdp', extension: 'txt' })
    expect(safeFileName('a\u{200B}b.txt')).toEqual({ stem: 'a b', extension: 'txt' })
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
