/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'bun:test'
import { downloadFile, withSuffix } from './download'

/*
 * The browser path only. The Tauri branch needs `@tauri-apps/plugin-fs`, which
 * has no meaning outside the webview — `isTauri()` is false here, so these
 * exercise the mechanism that actually runs on web.
 */
describe('downloadFile on the web', () => {
  it('names the file as asked', async () => {
    expect(await downloadFile({ name: 'q3.html', contents: '<p>x</p>', mimeType: 'text/html' })).toBe('q3.html')
  })

  it('clicks a download anchor and cleans it up', async () => {
    await downloadFile({ name: 'q3.html', contents: '<p>x</p>', mimeType: 'text/html' })

    // Removed synchronously — a stray anchor left in the body would accumulate
    // one per download for the life of the tab.
    expect(document.querySelector('a[download]')).toBeNull()
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
