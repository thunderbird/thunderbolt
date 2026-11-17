/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it, spyOn } from 'bun:test'
import { strToU8, zipSync } from 'fflate'
import { parseXmlWithXmlDom } from '@/test-utils/xml-dom-parser'
import { overlappingStoredEntries, withDeclaredSize, withZip64Count } from '@/test-utils/zip-fixtures'
import { matchPowerPoint, pptxPreviewLimits, renderPptxSnapshot } from './pptx-snapshot'

const slideXml = (tree: string) =>
  new DOMParser().parseFromString(
    '<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" ' +
      `xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:cSld><p:spTree>${tree}</p:spTree>` +
      '</p:cSld></p:sld>',
    'application/xml',
  )

const numbered = (text: string, number: string, level = '') =>
  `<a:p><a:pPr${level}>${number}</a:pPr><a:r><a:t>${text}</a:t></a:r></a:p>`

describe('matchPowerPoint', () => {
  parseXmlWithXmlDom()
  it('keeps where a numbered list starts only on its first paragraph, so the rest count on', () => {
    const start = '<a:buAutoNum type="arabicPeriod" startAt="3"/>'
    const slide = slideXml(
      '<p:sp><p:txBody><a:bodyPr/>' +
        numbered('First', start) +
        numbered('Second', start) +
        numbered('Nested', '<a:buAutoNum type="arabicPeriod" startAt="1"/>', ' lvl="1"') +
        numbered('Third', start) +
        '</p:txBody></p:sp>' +
        `<p:sp><p:txBody><a:bodyPr/>${numbered('Another list', start)}</p:txBody></p:sp>`,
    )

    matchPowerPoint(slide)

    const starts = [...slide.getElementsByTagName('a:buAutoNum')].map((number) => number.getAttribute('startAt'))
    expect(starts).toEqual(['3', null, '1', null, '3'])
  })

  it('keeps a number a list restarts at, which differs from the one before it', () => {
    const startAt = (value: string) => `<a:buAutoNum type="arabicPeriod" startAt="${value}"/>`
    const slide = slideXml(
      '<p:sp><p:txBody><a:bodyPr/>' +
        numbered('First', startAt('1')) +
        numbered('Second', startAt('1')) +
        numbered('Tenth', startAt('10')) +
        numbered('Eleventh', startAt('10')) +
        '</p:txBody></p:sp>',
    )

    matchPowerPoint(slide)

    const starts = [...slide.getElementsByTagName('a:buAutoNum')].map((number) => number.getAttribute('startAt'))
    expect(starts).toEqual(['1', null, '10', null])
  })

  it('turns a shape flipped both ways half a turn instead, and leaves a group and a single flip alone', () => {
    const slide = slideXml(
      '<p:sp><p:spPr><a:xfrm flipH="1" flipV="1" rot="10800000"/></p:spPr></p:sp>' +
        '<p:sp><p:spPr><a:xfrm flipH="true" flipV="true" rot="5400000"/></p:spPr></p:sp>' +
        '<p:sp><p:spPr><a:xfrm flipH="1"/></p:spPr></p:sp>' +
        '<p:grpSp><p:grpSpPr><a:xfrm flipH="1" flipV="1"/></p:grpSpPr></p:grpSp>',
    )

    matchPowerPoint(slide)

    const transforms = [...slide.getElementsByTagName('a:xfrm')].map((transform) =>
      ['rot', 'flipH', 'flipV'].map((name) => transform.getAttribute(name)),
    )
    expect(transforms).toEqual([
      ['0', null, null],
      ['16200000', null, null],
      [null, '1', null],
      [null, '1', '1'],
    ])
  })
})

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

  it('says a zip with no slides, such as a renamed workbook, cannot be previewed', async () => {
    const logged = spyOn(console, 'error').mockImplementation(() => {})
    try {
      const zip = zipSync({
        '[Content_Types].xml': strToU8('<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>'),
        'xl/workbook.xml': strToU8('<workbook/>'),
      })

      expect(await renderPptxSnapshot(new Blob([zip]))).toEqual({ kind: 'unreadable' })
      expect(logged.mock.calls[0][1]).toEqual(new Error('The deck has no slides'))
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
