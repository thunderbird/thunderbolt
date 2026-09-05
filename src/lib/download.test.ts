/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it, mock } from 'bun:test'
import { downloadFile, withSuffix, type DownloadFs } from './download'

const request = { name: 'q3.html', contents: '<p>x</p>', mimeType: 'text/html' }

/**
 * A stand-in for `@tauri-apps/plugin-fs`, refusing the names already `taken`
 * the way `createNew: true` makes the real one refuse.
 *
 * The desktop branch used to be untestable by construction — it reached for the
 * plugin at call time, which has no meaning outside the webview — so the branch
 * carrying the reported bug was the one branch with no coverage. `downloadFile`
 * takes the module as an argument for exactly this.
 */
const fakeFs = (taken: string[] = []) => {
  const written: { name: string; contents: string; createNew?: boolean }[] = []
  const fs: DownloadFs = {
    downloadBaseDir: 7,
    writeTextFile: mock(async (name: string, contents: string, options: { createNew?: boolean }) => {
      if (taken.includes(name)) {
        throw new Error(`File exists (os error 17): ${name}`)
      }
      written.push({ name, contents, createNew: options.createNew })
    }),
  }
  return { fs, written }
}

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

  it('cleans the anchor up', async () => {
    await downloadFile(request)

    // Removed synchronously — a stray anchor left in the body would accumulate
    // one per download for the life of the tab.
    expect(document.querySelector('a[download]')).toBeNull()
  })
})

describe('downloadFile on the desktop', () => {
  it('writes the bytes itself, into the Downloads directory', async () => {
    const { fs, written } = fakeFs()

    expect(await downloadFile(request, fs)).toBe('q3.html')
    expect(written).toEqual([{ name: 'q3.html', contents: '<p>x</p>', createNew: true }])
  })

  /**
   * `createNew` is the whole guarantee. An `exists()` check followed by a write
   * is two moments, and whatever lands in between — a second download of the
   * same artifact, a file the user saved by hand — was overwritten by a check
   * that had already passed.
   */
  it('always asks the filesystem to refuse an existing name', async () => {
    const { fs, written } = fakeFs()
    await downloadFile(request, fs)

    expect(written[0]?.createNew).toBe(true)
  })

  it('suffixes past the names already taken, as a browser does', async () => {
    const { fs } = fakeFs(['q3.html', 'q3 (1).html'])

    expect(await downloadFile(request, fs)).toBe('q3 (2).html')
  })

  /**
   * A refusal that isn't a collision looks identical from here, so it costs the
   * attempts and then surfaces *its own* message. That text is the only thing
   * that tells a missing `$DOWNLOAD` grant apart from a crowded folder — and
   * the button now shows it, which is what the second "still not working"
   * report needed.
   */
  it('rethrows the platform error rather than a synthesized one', async () => {
    const fs: DownloadFs = {
      downloadBaseDir: 7,
      writeTextFile: async () => {
        throw new Error('forbidden path: $DOWNLOAD/q3.html')
      },
    }

    await expect(downloadFile(request, fs)).rejects.toThrow('forbidden path: $DOWNLOAD/q3.html')
  })

  /** Bounded: an unbounded loop over a filesystem call is a hang waiting for an
   *  unusual disk. */
  it('gives up after twenty names', async () => {
    const taken = Array.from({ length: 20 }, (_, attempt) => withSuffix('q3.html', attempt))
    const { fs } = fakeFs(taken)

    await expect(downloadFile(request, fs)).rejects.toThrow('File exists')
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
