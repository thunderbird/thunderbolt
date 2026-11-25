/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { i18n } from '@/i18n'
import { BaseDirectory } from '@tauri-apps/api/path'
import { describe, expect, it, mock } from 'bun:test'
import {
  downloadFile,
  SaveError,
  saveErrorMessage,
  subscribeToMobileSaves,
  withSuffix,
  type DownloadNative,
  type MobileSave,
  type SaveToDownloadsArgs,
} from './download'

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
  const invoked: { command: string; args: SaveToDownloadsArgs }[] = []
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
    // The native command suffixes a taken name itself and reports what it used.
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

/**
 * Desktop and Android both save through `save_to_downloads`: Rust on desktop,
 * which marks the file as downloaded from the internet, and MediaStore on
 * Android, since `plugin-fs`'s `Download` there is app-private.
 */
describe.each(['macos', 'windows', 'linux', 'android'] as const)('downloadFile on %s', (platform) => {
  it('sends the bytes as base64 and returns the name the command used', async () => {
    const { native, written, invoked } = fakeNative(platform, ['report.pdf'])

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
    const { native, invoked } = fakeNative(platform)

    await downloadFile({ name: 'note.txt', contents: 'olá', mimeType: 'text/plain' }, native)

    expect(invoked[0]?.args.data).toBe('b2zDoQ==')
  })
})

describe('downloadFile errors from the native command', () => {
  /** Both sides reject with `{ code, message }`; the caller shows `String(error)`, which would read "[object Object]". */
  it.each(['android', 'windows'] as const)('surfaces the %s code and message as a SaveError', async (platform) => {
    const { native } = fakeNative(platform)
    const invoke = async () => {
      throw { code: 'mark_failed', message: 'Could not mark q3.html (Access is denied.).' }
    }

    const error = await downloadFile(request, { ...native, invoke }).catch((caught: Error) => caught)

    expect(error).toBeInstanceOf(SaveError)
    expect(error).toMatchObject({ code: 'mark_failed', message: 'Could not mark q3.html (Access is denied.).' })
  })

  /** Tauri itself rejects with a bare string, such as when the command is missing. */
  it('keeps a bare string rejection as the message, with no code', async () => {
    const { native } = fakeNative('linux')
    const invoke = async () => {
      throw 'command save_to_downloads not found'
    }

    const error = await downloadFile(request, { ...native, invoke }).catch((caught: Error) => caught)

    expect(error).toMatchObject({ code: undefined, message: 'command save_to_downloads not found' })
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

  /** Bytes need `writeFile` and its own grant; text keeps the `writeTextFile` it always used. */
  it('writes bytes with writeFile and text with writeTextFile', async () => {
    const { native, written } = fakeNative('ios')
    const bytes = new Uint8Array([37, 80, 68, 70])
    await downloadFile({ name: 'report.pdf', contents: bytes, mimeType: 'application/pdf' }, native)
    await downloadFile(request, native)

    expect(written.map(({ name, via }) => [name, via])).toEqual([
      ['report.pdf', 'writeFile'],
      ['q3.html', 'writeTextFile'],
    ])
    expect(written[0]?.contents).toBe(bytes)
  })

  /**
   * `createNew` is the whole guarantee. An `exists()` check followed by a write
   * is two moments, and whatever lands in between (a second download of the
   * same artifact, a file the user saved by hand) was overwritten by a check
   * that had already passed.
   */
  it('suffixes past the names already taken in Documents, as a browser does', async () => {
    const { native, written } = fakeNative('ios', ['report.docx', 'report (1).docx'])
    const bytes = new Uint8Array([80, 75, 3, 4])

    expect(await downloadFile({ name: 'report.docx', contents: bytes, mimeType: 'application/zip' }, native)).toBe(
      'report (2).docx',
    )
    expect(written).toEqual([
      { name: 'report (2).docx', contents: bytes, baseDir: BaseDirectory.Document, createNew: true, via: 'writeFile' },
    ])
  })

  /**
   * A refusal that isn't a collision looks identical from here, so it costs the
   * attempts and then surfaces *its own* message. That text is the only thing
   * that tells a missing grant apart from a crowded folder.
   */
  it('rethrows the platform error rather than a synthesized one', async () => {
    const { native } = fakeNative('ios')

    await expect(
      downloadFile(request, { ...native, fs: rejectingFs('forbidden path: $DOCUMENT/q3.html') }),
    ).rejects.toThrow('forbidden path: $DOCUMENT/q3.html')
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

  /** Bounded: an unbounded loop over a filesystem call is a hang waiting for an
   *  unusual disk. */
  it('gives up after twenty names', async () => {
    const taken = Array.from({ length: 20 }, (_, attempt) => withSuffix('q3.html', attempt))
    const { native } = fakeNative('ios', taken)

    await expect(downloadFile(request, native)).rejects.toThrow('File exists')
  })
})

describe('downloadFile names', () => {
  /** Windows refuses `:`, and a right-to-left override in the saved name made Downloads show an `.xlsx` as a `.docx`. */
  it.each([
    ['macos', 'Meeting 10:30.docx', 'Meeting 10 30.docx'],
    ['android', `annual${String.fromCharCode(0x202e)}xcod.xlsx`, 'annual xcod.xlsx'],
  ] as const)('makes the name safe before the %s command sees it', async (platform, name, saved) => {
    const { native, invoked } = fakeNative(platform)

    expect(await downloadFile({ ...request, name }, native)).toBe(saved)
    expect(invoked.map(({ args }) => args.name)).toEqual([saved])
  })

  it('makes the name safe on the web too', async () => {
    expect(await downloadFile({ ...request, name: 'a?b.html' })).toBe('a b.html')
  })
})

describe('subscribeToMobileSaves', () => {
  it.each(['ios', 'android'] as const)('hears a save on %s with the name it was saved under', async (platform) => {
    const { native } = fakeNative(platform, ['q3.html'])
    const saves: MobileSave[] = []
    const unsubscribe = subscribeToMobileSaves((save) => saves.push(save))

    await downloadFile(request, native)
    unsubscribe()
    await downloadFile(request, native)

    expect(saves).toEqual([{ name: 'q3 (1).html', platform }])
  })

  /** The desktop and the browser show their own download feedback. */
  it('hears nothing from a desktop save', async () => {
    const saves: MobileSave[] = []
    const unsubscribe = subscribeToMobileSaves((save) => saves.push(save))

    await downloadFile(request, fakeNative('linux').native)
    await downloadFile(request)
    unsubscribe()

    expect(saves).toEqual([])
  })
})

describe('saveErrorMessage', () => {
  const namesTaken =
    'Too many files with this name are already in the folder. Rename or move some of them, then try again.'

  it.each([
    ['names_taken', namesTaken],
    [
      'mark_failed',
      'The file could not be marked as downloaded from the internet, so it was not saved. The Downloads folder may be on a drive that cannot keep that mark.',
    ],
    ['no_downloads_folder', 'The folder to save into does not exist.'],
    ['needs_android_10', 'Saving files needs Android 10 or later.'],
  ])('explains the %s code in plain words', (code, reason) => {
    // The message quotes an OS error that would map elsewhere, so only the code can pick the reason.
    expect(i18n._(saveErrorMessage(new SaveError(code, 'Permission denied (os error 13)')))).toBe(reason)
  })

  it('falls back to the generic reason for a code it has no words for', () => {
    expect(i18n._(saveErrorMessage(new SaveError('not_a_file_name', '"a/b" is not a file name')))).toBe(
      'Something went wrong while saving the file.',
    )
  })

  it.each([
    [
      'failed to open file at path: /var/mobile/Containers/Data/Application/1/Documents/q3 (19).html with error: File exists (os error 17)',
      namesTaken,
    ],
    [
      'Could not save q3.html to Downloads: No such file or directory (os error 2)',
      'The folder to save into does not exist.',
    ],
    [
      'Could not save q3.html to Downloads: No space left on device (os error 28)',
      'There is not enough free space on this device.',
    ],
    ['ENOSPC (No space left on device)', 'There is not enough free space on this device.'],
    ['forbidden path: $DOCUMENT/q3.html', 'Thunderbolt is not allowed to save there.'],
    ['something nobody expected', 'Something went wrong while saving the file.'],
  ])('reads the OS text of an uncoded failure: %s', (raw, reason) => {
    expect(i18n._(saveErrorMessage(new Error(raw)))).toBe(reason)
    expect(i18n._(saveErrorMessage(new SaveError('write_failed', raw)))).toBe(reason)
    expect(i18n._(saveErrorMessage(raw))).toBe(reason)
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
