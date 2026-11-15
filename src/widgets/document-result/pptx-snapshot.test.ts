/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it, spyOn } from 'bun:test'
import { strToU8, zipSync } from 'fflate'
import { overlappingStoredEntries, withDeclaredSize, withZip64Count } from '@/test-utils/zip-fixtures'
import { pptxPreviewLimits, renderPptxSnapshot } from './pptx-snapshot'

// Rendering needs layout and canvases, which happy-dom lacks; e2e/consumer-pptx-preview.spec.ts renders real decks.
describe('renderPptxSnapshot', () => {
  it('refuses a file over 10 MiB before reading it', async () => {
    const snapshot = await renderPptxSnapshot(new Blob([new Uint8Array(pptxPreviewLimits.fileBytes + 1)]))

    expect(snapshot).toEqual({ kind: 'tooLarge' })
  })

  it('refuses a small file whose parts would unpack past the limit', async () => {
    const zip = zipSync({
      'ppt/presentation.xml': strToU8('<p:presentation/>'),
      'ppt/media/padding.bin': new Uint8Array(pptxPreviewLimits.unzipBytes),
    })

    expect(zip.byteLength).toBeLessThan(pptxPreviewLimits.fileBytes)
    expect(await renderPptxSnapshot(new Blob([zip]))).toEqual({ kind: 'tooLarge' })
  })

  it('counts stored parts that share one payload at their packed size', async () => {
    const zip = overlappingStoredEntries(40)

    expect(zip.byteLength).toBeLessThan(pptxPreviewLimits.fileBytes)
    expect(await renderPptxSnapshot(new Blob([zip]))).toEqual({ kind: 'tooLarge' })
  })

  it('refuses a zip that claims more parts than a classic zip can list', async () => {
    const zip = zipSync({ 'ppt/presentation.xml': strToU8('<p:presentation/>') }, { level: 0 })

    expect(await renderPptxSnapshot(new Blob([withZip64Count(zip, 70_000)]))).toEqual({ kind: 'tooLarge' })
  })

  it('says a deck with a part that unpacks to more than it declares cannot be previewed', async () => {
    const logged = spyOn(console, 'error').mockImplementation(() => {})
    try {
      const zip = zipSync({ 'ppt/slides/padding.xml': new Uint8Array(64 * 1024 * 1024).fill(32) })

      const snapshot = await renderPptxSnapshot(new Blob([withDeclaredSize(zip, 'ppt/slides/padding.xml', 9)]))

      expect(snapshot).toEqual({ kind: 'unreadable' })
    } finally {
      logged.mockRestore()
    }
  })

  it('says a file that is no zip cannot be previewed', async () => {
    const logged = spyOn(console, 'error').mockImplementation(() => {})
    try {
      expect(await renderPptxSnapshot(new Blob(['not a deck']))).toEqual({ kind: 'unreadable' })
      expect(logged).toHaveBeenCalled()
    } finally {
      logged.mockRestore()
    }
  })
})
