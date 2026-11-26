/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it, spyOn } from 'bun:test'
import { Document, ImageRun, LevelFormat, Packer, Paragraph, TextRun } from 'docx'
import { strToU8, zipSync } from 'fflate'
import { expectSampleDocxPreview } from '@/test-utils/docx-preview'
import { hostileAltChunkText, hostileDocx, hostileDocxProbeOrigin, hostileLinkText } from '@/test-utils/hostile-docx'
import { pixelPng, sampleDocx } from '@/test-utils/sample-docx'
import { parseXmlWithXmlDom } from '@/test-utils/xml-dom-parser'
import { overlappingStoredEntries, withZip64Count } from '@/test-utils/zip-fixtures'
import { docxPreviewLimits, renderDocxSnapshot } from './docx-snapshot'

parseXmlWithXmlDom()

const pagesOf = async (blob: Blob) => {
  const snapshot = await renderDocxSnapshot(blob)
  if (snapshot.kind !== 'pages') {
    throw new Error('The document was refused')
  }
  return snapshot
}

const parse = (html: string) => new DOMParser().parseFromString(html, 'text/html')

/** A document body, as `word/document.xml` holds it. */
const body = (xml: string) =>
  strToU8(
    '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" ' +
      'xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math" ' +
      `xmlns:v="urn:schemas-microsoft-com:vml"><w:body>${xml}</w:body></w:document>`,
  )

/** A DOCX with the given parts, whose main part is `word/document.xml`. */
const docx = (parts: Record<string, Uint8Array>) =>
  zipSync({
    '[Content_Types].xml': strToU8(
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
        '<Default Extension="xml" ContentType="application/xml"/></Types>',
    ),
    '_rels/.rels': strToU8(
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" ' +
        'Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" ' +
        'Target="word/document.xml"/></Relationships>',
    ),
    ...parts,
  })

describe('renderDocxSnapshot', () => {
  it('renders the pages with their headings, lists, table and picture, fitting the page width plus the margin', async () => {
    const { html, width, reflowStyle } = await pagesOf(await sampleDocx())

    expectSampleDocxPreview(html)
    // An A4 page is 595.3pt, 794px; the wrapper adds 30px on each side. A narrower frame scales or reflows the pages.
    expect(width).toBe(854)
    expect(reflowStyle).toStartWith('<style>@media (max-width: 853px) {')
    expect(html).not.toContain('max-width: 853px')
    // The view adds the style that zooms the pages, only in a browser that draws them zoomed as they are.
    expect(html).not.toContain('100cqw')
  })

  it('gives tables separate borders on a screen with 3 device pixels per CSS pixel, however the pages are drawn', async () => {
    const { html } = await pagesOf(await sampleDocx())

    expect(html).toContain(
      '<style>@media (min-resolution: 3dppx) { table { border-collapse: separate !important; border-spacing: 0; } }</style>',
    )
  })

  it('lets the page load nothing but its own styles and its data: pictures and fonts', async () => {
    const { html } = await pagesOf(await sampleDocx())

    const policies = [...parse(html).querySelectorAll('meta')].map((meta) => [
      meta.getAttribute('http-equiv'),
      meta.getAttribute('content'),
    ])
    expect(policies).toEqual([
      ['Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:"],
    ])
  })

  it('leaves out an embedded HTML part, link targets and a linked picture, and keeps file text inside its CSS', async () => {
    const { html } = await pagesOf(new Blob([hostileDocx()]))
    const page = parse(html)

    expect(page.body.textContent).toContain('Hostile document')
    expect(page.body.textContent).not.toContain(hostileAltChunkText)
    expect(page.querySelectorAll('script, iframe, object, embed, base, form')).toHaveLength(0)
    expect(page.querySelectorAll('meta')).toHaveLength(1)
    expect(page.querySelectorAll('[href], [onload], [onerror]')).toHaveLength(0)
    expect(page.body.textContent).toContain(hostileLinkText)
    expect(html).not.toContain(`${hostileDocxProbeOrigin}/linked.png`)
    // The font name stays in a CSS rule: its `<` is escaped, so it cannot end the style element.
    expect([...page.head.querySelectorAll('style')].some((style) => style.textContent?.includes('\\3c /style'))).toBe(
      true,
    )
  })

  it('keeps an inline picture in its paragraph, between the text around it', async () => {
    const picture = new ImageRun({ type: 'png', data: pixelPng, transformation: { width: 24, height: 24 } })
    const document = new Document({
      sections: [{ children: [new Paragraph({ children: [new TextRun('Before'), picture, new TextRun('after')] })] }],
    })
    const { html } = await pagesOf(await Packer.toBlob(document))

    // happy-dom keeps a <div> inside a <p>, where a browser's parser closes the <p>, so no <div> may be left there.
    const page = parse(html)
    expect(page.querySelectorAll('p div')).toHaveLength(0)
    expect(page.querySelector('img')?.closest('p')?.textContent).toBe('Beforeafter')
  })

  it('aligns a right-to-left paragraph set to left or right to its start or end, as Word does', async () => {
    const paragraph = (text: string, props: string) => `<w:p><w:pPr>${props}</w:pPr><w:r><w:t>${text}</w:t></w:r></w:p>`
    const { html } = await pagesOf(
      new Blob([
        docx({
          'word/document.xml': body(
            paragraph('مرحبا', '<w:bidi/><w:jc w:val="left"/>') +
              paragraph('שלום', '<w:bidi/><w:jc w:val="right"/>') +
              paragraph('Hello', '<w:jc w:val="right"/>'),
          ),
        }),
      ]),
    )

    const alignments = [...parse(html).querySelectorAll<HTMLElement>('section p')].map((p) => [
      p.textContent,
      p.style.textAlign,
    ])
    expect(alignments).toEqual([
      ['مرحبا', 'start'],
      ['שלום', 'end'],
      ['Hello', 'right'],
    ])
  })

  it('aligns right-to-left paragraph styles to their start or end, as Word does', async () => {
    const style = (id: string, props: string) =>
      `<w:style w:type="paragraph" w:styleId="${id}"><w:pPr>${props}</w:pPr></w:style>`
    const { html } = await pagesOf(
      new Blob([
        docx({
          'word/document.xml': body('<w:p><w:pPr><w:pStyle w:val="ArabicLeft"/></w:pPr></w:p>'),
          'word/_rels/document.xml.rels': strToU8(
            '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship ' +
              'Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" ' +
              'Target="styles.xml"/></Relationships>',
          ),
          'word/styles.xml': strToU8(
            '<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
              style('ArabicLeft', '<w:bidi/><w:jc w:val="left"/>') +
              style('ArabicRight', '<w:bidi/><w:jc w:val="right"/>') +
              style('Latin', '<w:jc w:val="left"/>') +
              '</w:styles>',
          ),
        }),
      ]),
    )

    const css = [...parse(html).querySelectorAll('style')].map((element) => element.textContent).join('')
    expect(css).toMatch(/p\.docx_arabicleft \{[^}]*direction: rtl;[^}]*text-align: start;/)
    expect(css).toMatch(/p\.docx_arabicright \{[^}]*direction: rtl;[^}]*text-align: end;/)
    expect(css).toMatch(/p\.docx_latin \{[^}]*text-align: left;/)
  })

  it('aligns a paragraph set to left or right to its start or end when its style, or one it is based on, is right-to-left', async () => {
    const style = (id: string, props: string) => `<w:style w:type="paragraph" w:styleId="${id}">${props}</w:style>`
    const paragraph = (text: string, styleId: string, props: string) =>
      `<w:p><w:pPr><w:pStyle w:val="${styleId}"/>${props}</w:pPr><w:r><w:t>${text}</w:t></w:r></w:p>`
    const { html } = await pagesOf(
      new Blob([
        docx({
          'word/document.xml': body(
            paragraph('مرحبا', 'Arabic', '<w:jc w:val="left"/>') +
              paragraph('שלום', 'Hebrew', '<w:jc w:val="right"/>') +
              paragraph('Hello', 'Latin', '<w:jc w:val="right"/>'),
          ),
          'word/_rels/document.xml.rels': strToU8(
            '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship ' +
              'Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" ' +
              'Target="styles.xml"/></Relationships>',
          ),
          'word/styles.xml': strToU8(
            '<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
              style('Arabic', '<w:pPr><w:bidi/></w:pPr>') +
              style('Hebrew', '<w:basedOn w:val="Arabic"/>') +
              style('Latin', '<w:pPr><w:jc w:val="left"/></w:pPr>') +
              '</w:styles>',
          ),
        }),
      ]),
    )

    const alignments = [...parse(html).querySelectorAll<HTMLElement>('section p')].map((p) => [
      p.textContent,
      p.style.textAlign,
    ])
    expect(alignments).toEqual([
      ['مرحبا', 'start'],
      ['שלום', 'end'],
      ['Hello', 'right'],
    ])
  })

  it('aligns a paragraph to its start when the default paragraph style is right-to-left', async () => {
    const { html } = await pagesOf(
      new Blob([
        docx({
          'word/document.xml': body('<w:p><w:pPr><w:jc w:val="left"/></w:pPr><w:r><w:t>مرحبا</w:t></w:r></w:p>'),
          'word/_rels/document.xml.rels': strToU8(
            '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship ' +
              'Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" ' +
              'Target="styles.xml"/></Relationships>',
          ),
          'word/styles.xml': strToU8(
            '<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
              '<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:pPr><w:bidi/></w:pPr></w:style>' +
              '</w:styles>',
          ),
        }),
      ]),
    )

    expect(parse(html).querySelector<HTMLElement>('section p')?.style.textAlign).toBe('start')
  })

  it('blanks a picture whose header claims more pixels than the preview decodes, and keeps the rest', async () => {
    const huge = pixelPng.slice()
    const header = new DataView(huge.buffer)
    header.setUint32(16, 8192)
    header.setUint32(20, 8192)
    const pictureOf = (data: Uint8Array) =>
      new ImageRun({ type: 'png', data, transformation: { width: 24, height: 24 } })
    const document = new Document({
      sections: [{ children: [new Paragraph({ children: [pictureOf(pixelPng), pictureOf(huge)] })] }],
    })
    const { html } = await pagesOf(await Packer.toBlob(document))

    const sources = [...parse(html).querySelectorAll('img')].map((picture) => picture.getAttribute('src'))
    expect(sources).toEqual([
      `data:image/png;base64,${btoa(String.fromCharCode(...pixelPng))}`,
      'data:image/png;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7',
    ])
  })

  it("draws Word's Symbol bullet as a bullet, not as a private-use character only Windows draws", async () => {
    const document = new Document({
      numbering: {
        config: [
          {
            reference: 'word-bullets',
            levels: [{ level: 0, format: LevelFormat.BULLET, text: '\uF0B7', style: { run: { font: 'Symbol' } } }],
          },
        ],
      },
      sections: [{ children: [new Paragraph({ text: 'Item', numbering: { reference: 'word-bullets', level: 0 } })] }],
    })
    const { html } = await pagesOf(await Packer.toBlob(document))

    const css = [...parse(html).querySelectorAll('style')].map((style) => style.textContent).join('')
    expect(css).not.toContain('\uF0B7')
    expect(css).toContain('content: "\u2022')
  })

  it.each([
    ['is not a zip', new Blob(['plain text'])],
    [
      'holds an equation the renderer cannot draw',
      new Blob([
        docx({
          'word/document.xml': body('<w:p><m:oMath><m:d><m:e><m:r><m:t>x</m:t></m:r></m:e></m:d></m:oMath></w:p>'),
        }),
      ]),
    ],
  ])('turns a file that %s into a refusal, not an error, so Download still works', async (_, blob) => {
    const logged = spyOn(console, 'error').mockImplementation(() => {})
    try {
      expect(await renderDocxSnapshot(blob)).toEqual({ kind: 'unreadable' })
      expect(logged).toHaveBeenCalledTimes(1)
    } finally {
      logged.mockRestore()
    }
  })

  it('refuses a file over the size limit without reading it', async () => {
    const snapshot = await renderDocxSnapshot(new Blob([new Uint8Array(docxPreviewLimits.fileBytes + 1)]))

    expect(snapshot).toEqual({ kind: 'tooLarge' })
  })

  it.each(['word/document.xml', 'word/folder/../document.xml', 'word\\document.xml'])(
    'refuses a body past the limit stored as %s, a name docx-preview reads as word/document.xml',
    async (name) => {
      const zip = docx({ [name]: body(' '.repeat(docxPreviewLimits.documentXmlBytes)) })

      expect(zip.byteLength).toBeLessThan(docxPreviewLimits.fileBytes)
      expect(await renderDocxSnapshot(new Blob([zip]))).toEqual({ kind: 'tooLarge' })
    },
  )

  it('refuses a small file whose parts unpack past the total limit', async () => {
    const zip = docx({
      'word/document.xml': body('<w:p/>'),
      'word/media/padding.bin': new Uint8Array(docxPreviewLimits.unzipBytes),
    })

    expect(zip.byteLength).toBeLessThan(docxPreviewLimits.fileBytes)
    expect(await renderDocxSnapshot(new Blob([zip]))).toEqual({ kind: 'tooLarge' })
  })

  it('refuses a small file whose stored parts all point at one payload while declaring nothing unpacked', async () => {
    // 40 entries of 1 MiB each: past the total limit, from a file of about 1 MiB.
    const zip = overlappingStoredEntries(40)

    expect(zip.byteLength).toBeLessThan(docxPreviewLimits.fileBytes)
    expect(await renderDocxSnapshot(new Blob([zip]))).toEqual({ kind: 'tooLarge' })
  })

  it('refuses a zip whose directory claims more parts than a classic zip can list, without scanning them all', async () => {
    const zip = withZip64Count(docx({ 'word/document.xml': body('<w:p/>') }), 1_000_000)

    expect(await renderDocxSnapshot(new Blob([zip]))).toEqual({ kind: 'tooLarge' })
  })

  it('gives pages with no width of their own a Letter width, so the thumbnail still has one to scale to', async () => {
    const { width } = await pagesOf(
      new Blob([docx({ 'word/document.xml': body('<w:p><w:r><w:t>No size</w:t></w:r></w:p>') })]),
    )

    // 612pt is 816px; the wrapper adds 30px on each side.
    expect(width).toBe(876)
  })

  it('drops the size the renderer measures for a legacy drawing, which is 0 with no layout', async () => {
    // The library measures each drawing on the next frame; here the frame comes at once, so the 0 it measures is set.
    const frame = spyOn(globalThis, 'requestAnimationFrame').mockImplementation((callback) => {
      callback(0)
      return 0
    })
    try {
      const line = '<w:p><w:r><w:pict><v:line from="0,10pt" to="200pt,10pt"/></w:pict></w:r></w:p>'
      const { html } = await pagesOf(new Blob([docx({ 'word/document.xml': body(line) })]))

      const drawings = [...parse(html).querySelectorAll('svg')]
      expect(drawings).toHaveLength(1)
      expect(drawings.map((svg) => [svg.getAttribute('width'), svg.getAttribute('height')])).toEqual([[null, null]])
    } finally {
      frame.mockRestore()
    }
  })
})
