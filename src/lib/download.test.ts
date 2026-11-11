/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { BaseDirectory } from '@tauri-apps/api/path'
import { describe, expect, it, mock } from 'bun:test'
import { downloadFile, withSuffix, type AndroidSaveArgs, type DownloadNative } from './download'

const request = { name: 'q3.html', contents: '<p>x</p>', mimeType: 'text/html' }

/**
 * A stand-in for `@tauri-apps/plugin-fs` and `invoke` on `platform`, refusing
 * the names already `taken` the way `createNew: true` makes the real fs refuse.
 *
 * The Tauri branches once loaded the plugin at call time, and the plugin means
 * nothing outside the webview, so the branches with the reported bugs had no
 * tests. `downloadFile` takes these as an argument so the tests can supply them.
 */
const fakeNative = (platform: DownloadNative['platform'], taken: string[] = []) => {
  const written: { name: string; contents: string | Uint8Array; baseDir: number; createNew?: boolean; via: string }[] =
    []
  const invoked: { command: string; args: AndroidSaveArgs }[] = []
  const write =
    (via: string) =>
    async (name: string, contents: string | Uint8Array, options: { baseDir: number; createNew?: boolean }) => {
      if (taken.includes(name)) {
        throw new Error(`File exists (os error 17): ${name}`)
      }
      written.push({ name, contents, baseDir: options.baseDir, createNew: options.createNew, via })
    }
  const native: DownloadNative = {
    platform,
    fs: { writeTextFile: mock(write('writeTextFile')), writeFile: mock(write('writeFile')) },
    // MediaStore suffixes a taken name itself and reports what it used.
    invoke: async (command, args) => {
      invoked.push({ command, args })
      return { name: taken.includes(args.name) ? withSuffix(args.name, 1) : args.name }
    },
  }
  return { native, written, invoked }
}

const rejectingFs = (message: string): DownloadNative['fs'] => ({
  writeTextFile: async () => {
    throw new Error(message)
  },
  writeFile: async () => {
    throw new Error(message)
  },
})

describe('downloadFile on the web', () => {
  it('names the file as asked', async () => {
    expect(await downloadFile(request)).toBe('q3.html')
  })

  /**
   * The click *is* the download on the web — an anchor that is created,
   * appended and removed without being clicked saves nothing, and the previous
   * version of this test asserted only the cleanup, so it would have passed.
   */
  it('clicks the download anchor', async () => {
    const clicked: string[] = []
    const createElement = document.createElement.bind(document)
    const spy = mock((tag: string) => {
      const element = createElement(tag)
      if (tag === 'a') {
        element.click = () => clicked.push((element as HTMLAnchorElement).download)
      }
      return element
    })
    document.createElement = spy as typeof document.createElement

    try {
      await downloadFile(request)
    } finally {
      document.createElement = createElement
    }

    expect(clicked).toEqual(['q3.html'])
  })

  it('downloads bytes as a blob of the given type', async () => {
    const blobs: Blob[] = []
    const createObjectURL = URL.createObjectURL
    URL.createObjectURL = (blob: Blob) => {
      blobs.push(blob)
      return 'blob:test'
    }
    try {
      await downloadFile({
        name: 'report.pdf',
        contents: new Uint8Array([37, 80, 68, 70]),
        mimeType: 'application/pdf',
      })
    } finally {
      URL.createObjectURL = createObjectURL
    }

    expect(blobs[0]?.type).toBe('application/pdf')
    expect(new Uint8Array(await blobs[0]!.arrayBuffer())).toEqual(new Uint8Array([37, 80, 68, 70]))
  })

  it('cleans the anchor up', async () => {
    await downloadFile(request)

    // Removed synchronously — a stray anchor left in the body would accumulate
    // one per download for the life of the tab.
    expect(document.querySelector('a[download]')).toBeNull()
  })
})

describe('downloadFile on the desktop', () => {
  it('writes the bytes itself, into the Downloads directory', async () => {
    const { native, written, invoked } = fakeNative('macos')

    expect(await downloadFile(request, native)).toBe('q3.html')
    expect(written).toEqual([
      { name: 'q3.html', contents: '<p>x</p>', baseDir: BaseDirectory.Download, createNew: true, via: 'writeTextFile' },
    ])
    expect(invoked).toEqual([])
  })

  /** Bytes need `writeFile` and its own grant; text keeps the `writeTextFile` it always used. */
  it('writes bytes with writeFile and text with writeTextFile', async () => {
    const { native, written } = fakeNative('windows')
    const bytes = new Uint8Array([37, 80, 68, 70])
    await downloadFile({ name: 'report.pdf', contents: bytes, mimeType: 'application/pdf' }, native)
    await downloadFile(request, native)

    expect(written.map(({ name, via }) => [name, via])).toEqual([
      ['report.pdf', 'writeFile'],
      ['q3.html', 'writeTextFile'],
    ])
    expect(written[0]?.contents).toBe(bytes)
  })

  it('suffixes a taken name for bytes too', async () => {
    const { native } = fakeNative('linux', ['report.pdf'])

    expect(
      await downloadFile({ name: 'report.pdf', contents: new Uint8Array([1]), mimeType: 'application/pdf' }, native),
    ).toBe('report (1).pdf')
  })

  /**
   * `createNew` is the whole guarantee. An `exists()` check followed by a write
   * is two moments, and whatever lands in between — a second download of the
   * same artifact, a file the user saved by hand — was overwritten by a check
   * that had already passed.
   */
  it('always asks the filesystem to refuse an existing name', async () => {
    const { native, written } = fakeNative('macos')
    await downloadFile(request, native)

    expect(written[0]?.createNew).toBe(true)
  })

  it('suffixes past the names already taken, as a browser does', async () => {
    const { native } = fakeNative('macos', ['q3.html', 'q3 (1).html'])

    expect(await downloadFile(request, native)).toBe('q3 (2).html')
  })

  /**
   * A refusal that isn't a collision looks identical from here, so it costs the
   * attempts and then surfaces *its own* message. That text is the only thing
   * that tells a missing `$DOWNLOAD` grant apart from a crowded folder — and
   * the button now shows it, which is what the second "still not working"
   * report needed.
   */
  it('rethrows the platform error rather than a synthesized one', async () => {
    const { native } = fakeNative('macos')

    await expect(
      downloadFile(request, { ...native, fs: rejectingFs('forbidden path: $DOWNLOAD/q3.html') }),
    ).rejects.toThrow('forbidden path: $DOWNLOAD/q3.html')
  })

  /** Bounded: an unbounded loop over a filesystem call is a hang waiting for an
   *  unusual disk. */
  it('gives up after twenty names', async () => {
    const taken = Array.from({ length: 20 }, (_, attempt) => withSuffix('q3.html', attempt))
    const { native } = fakeNative('macos', taken)

    await expect(downloadFile(request, native)).rejects.toThrow('File exists')
  })
})

/**
 * Tauri resolves `Download` to a `~/Downloads` the iOS sandbox doesn't have, so
 * every write there failed. `Documents` is the folder the Files app shows.
 */
describe('downloadFile on iOS', () => {
  it('writes into Documents, never Downloads', async () => {
    const { native, written, invoked } = fakeNative('ios')

    expect(await downloadFile(request, native)).toBe('q3.html')
    expect(written).toEqual([
      { name: 'q3.html', contents: '<p>x</p>', baseDir: BaseDirectory.Document, createNew: true, via: 'writeTextFile' },
    ])
    expect(invoked).toEqual([])
  })

  it('suffixes past the names already taken in Documents', async () => {
    const { native, written } = fakeNative('ios', ['report.docx', 'report (1).docx'])
    const bytes = new Uint8Array([80, 75, 3, 4])

    expect(await downloadFile({ name: 'report.docx', contents: bytes, mimeType: 'application/zip' }, native)).toBe(
      'report (2).docx',
    )
    expect(written).toEqual([
      { name: 'report (2).docx', contents: bytes, baseDir: BaseDirectory.Document, createNew: true, via: 'writeFile' },
    ])
  })

  /** Tauri rejects with a bare string; the wrapper must name the folder actually used. */
  it('names Documents when the platform rejects with a string', async () => {
    const { native } = fakeNative('ios')
    const refuse = async () => {
      throw 'forbidden path'
    }

    await expect(
      downloadFile(request, { ...native, fs: { writeTextFile: refuse, writeFile: refuse } }),
    ).rejects.toThrow('Could not save q3.html to Documents: forbidden path')
  })
})

/**
 * `Download` on Android is the app-private `getExternalFilesDir`, which no file
 * browser shows, so the save goes through MediaStore in the Kotlin plugin.
 */
describe('downloadFile on Android', () => {
  it('sends the bytes as base64 and returns the name MediaStore used', async () => {
    const { native, written, invoked } = fakeNative('android', ['report.pdf'])

    const saved = await downloadFile(
      { name: 'report.pdf', contents: new Uint8Array([37, 80, 68, 70]), mimeType: 'application/pdf' },
      native,
    )

    expect(saved).toBe('report (1).pdf')
    expect(invoked).toEqual([
      {
        command: 'plugin:platform-utils|save_to_downloads',
        args: { name: 'report.pdf', mimeType: 'application/pdf', data: 'JVBERg==' },
      },
    ])
    expect(written).toEqual([])
  })

  it('encodes text as UTF-8', async () => {
    const { native, invoked } = fakeNative('android')

    await downloadFile({ name: 'note.txt', contents: 'olá', mimeType: 'text/plain' }, native)

    expect(invoked[0]?.args.data).toBe('b2zDoQ==')
  })

  /** Kotlin rejects with `{ message }`; the caller shows `String(error)`, which would read "[object Object]". */
  it("surfaces the plugin's message as an Error", async () => {
    const { native } = fakeNative('android')
    const invoke = async () => {
      throw { message: 'Saving files needs Android 10 or later' }
    }

    await expect(downloadFile(request, { ...native, invoke })).rejects.toThrow(
      new Error('Saving files needs Android 10 or later'),
    )
  })
})

describe('withSuffix', () => {
  it('leaves the first attempt alone', () => {
    expect(withSuffix('q3.html', 0)).toBe('q3.html')
  })

  it('inserts the counter before the extension, as a browser does', () => {
    expect(withSuffix('q3.html', 1)).toBe('q3 (1).html')
    expect(withSuffix('report.final.html', 2)).toBe('report.final (2).html')
  })

  it('appends when there is no extension to protect', () => {
    expect(withSuffix('noext', 1)).toBe('noext (1)')
  })

  /** A leading dot is the whole name, not an extension — `.hidden (1)`, never `(1).hidden`. */
  it('treats a dotfile as having no extension', () => {
    expect(withSuffix('.hidden', 1)).toBe('.hidden (1)')
  })
})
