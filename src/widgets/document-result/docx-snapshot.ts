/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { defaultOptions, type Options, parseAsync, renderDocument } from 'docx-preview'
import { unzipSync, zipSync } from 'fflate'

const mib = 1024 * 1024

/** Past any limit the preview is refused. At these limits every measured preview painted in under a second. */
export const docxPreviewLimits = {
  fileBytes: 10 * mib,
  /** What `word/document.xml` unpacks to. 3.5 MB is about 1,000 pages. */
  documentXmlBytes: 3_500_000,
  /**
   * What all the parts together unpack to. Pictures barely compress, so a document at the file limit unpacks to
   * little more than its size; this stops a small file that would unpack to gigabytes.
   */
  unzipBytes: 32 * mib,
  /** The most parts a classic zip lists. A ZIP64 directory can claim more than it holds. */
  parts: 65_535,
}

/** A document's pages as markup for the sandboxed frame, with their width in CSS pixels, or why there are none. */
export type DocxSnapshot =
  | { kind: 'pages'; html: string; width: number }
  | { kind: 'tooLarge' }
  | { kind: 'unreadable' }

/** The snapshot's own policy: its styles, and pictures and fonts embedded as `data:` URLs. Nothing else loads. */
const snapshotPolicy = "default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:"

/** The padding the renderer's wrapper puts on each side of the pages. */
const wrapperPadding = 30

/** US Letter, for a document whose pages give no width: the thumbnail still needs one to scale to. */
const letterWidthPt = 612

/** A part's name as the renderer's zip reader resolves it, applying `.`, `..` and empty segments. */
const resolvePartName = (name: string) => {
  const segments: string[] = []
  name.split('/').forEach((segment, index, all) => {
    if (segment === '..') {
      segments.pop()
    } else if (segment !== '.' && (segment !== '' || index === 0 || index === all.length - 1)) {
      segments.push(segment)
    }
  })
  return segments.join('/')
}

/** Thrown for a file past one of {@link docxPreviewLimits}. */
class PastLimitsError extends Error {}

/**
 * The file's parts, unpacked within the limits and stored again without compression. The renderer's zip reader
 * (JSZip) unpacks a part in full before it compares it with the size the zip declares, so it only gets parts unpacked
 * here first, each into a buffer no larger than counted.
 */
const unpackWithinLimits = async (blob: Blob) => {
  if (blob.size > docxPreviewLimits.fileBytes) {
    throw new PastLimitsError()
  }
  const unpacked = { parts: 0, bytes: 0 }
  const entries = unzipSync(new Uint8Array(await blob.arrayBuffer()), {
    // fflate copies a stored part at its packed size and inflates one into a buffer of its declared size, so each
    // part counts at the larger of the two. Throwing ends the scan, which a forged ZIP64 entry count can stretch.
    filter: ({ size, originalSize }) => {
      unpacked.parts += 1
      unpacked.bytes += Math.max(size, originalSize)
      if (unpacked.parts > docxPreviewLimits.parts || unpacked.bytes > docxPreviewLimits.unzipBytes) {
        throw new PastLimitsError()
      }
      return true
    },
  })
  // A later part with the same resolved name replaces an earlier one, as in the zip reader.
  const parts = Object.fromEntries(Object.entries(entries).map(([name, data]) => [resolvePartName(name), data]))
  // The renderer also looks a part up by its name with backslashes.
  const body = parts['word/document.xml'] ?? parts['word\\document.xml']
  if ((body?.length ?? 0) > docxPreviewLimits.documentXmlBytes) {
    throw new PastLimitsError()
  }
  return zipSync(parts, { level: 0 })
}

/** The widest page plus the wrapper around it, in CSS pixels. The renderer gives each page's width in points. */
const pagesWidth = (wrapper: Element) => {
  const points = [...wrapper.querySelectorAll<HTMLElement>('section.docx')].map(
    (page) => parseFloat(page.style.width) || 0,
  )
  return Math.ceil(((Math.max(0, ...points) || letterWidthPt) * 96) / 72) + 2 * wrapperPadding
}

/**
 * Word's bullets are private-use characters of the Symbol and Wingdings fonts, which only Windows draws; elsewhere
 * they show as empty boxes. These are the Unicode characters that look the same.
 */
const fontBullets = new Map([
  ['', '•'],
  ['', '▪'],
  ['', '■'],
  ['', '❖'],
  ['', '➢'],
  ['', '✓'],
])
const fontBulletPattern = new RegExp(`[${[...fontBullets.keys()].join('')}]`, 'g')

/**
 * A style element's text, with `<` escaped as CSS reads it, so text from the file cannot close the element, and with
 * Word's bullets as characters every platform draws.
 */
const styleMarkup = (style: HTMLStyleElement) => {
  const css = (style.textContent ?? '').replaceAll('<', '\\3c ')
  return `<style>${css.replace(fontBulletPattern, (bullet) => fontBullets.get(bullet) ?? bullet)}</style>`
}

/**
 * The pages the renderer builds from the parts: its style elements and the wrapper around the pages. It builds them
 * in a document with no window, so nothing in them loads or runs while it works.
 */
const renderPages = async (parts: Uint8Array) => {
  const inert = document.implementation.createHTMLDocument('')
  const options: Partial<Options> = {
    // An altChunk is HTML from the file, which the library would show in a frame with no sandbox.
    renderAltChunks: false,
    // `data:` URLs, the only ones the policy loads.
    useBase64URL: true,
    h: (node) => inert.adoptNode(defaultOptions.h(node)),
  }
  const nodes = await renderDocument(await parseAsync(parts, options), options)
  const wrapper = nodes.find((node) => node instanceof HTMLDivElement)
  if (!wrapper) {
    throw new Error('The document has no body')
  }
  return { styles: nodes.filter((node) => node instanceof HTMLStyleElement), wrapper }
}

/** Changes what would not survive as static markup: links, pictures in paragraphs, and the size of legacy drawings. */
const prepareForMarkup = (wrapper: HTMLDivElement) => {
  for (const link of wrapper.querySelectorAll('a[href]')) {
    link.removeAttribute('href')
  }
  // The library wraps an inline picture in a <div> inside its <p>; parsed back from markup, a <div> closes the <p>.
  for (const block of wrapper.querySelectorAll('p div')) {
    const inline = wrapper.ownerDocument.createElement('span')
    for (const { name, value } of block.attributes) {
      inline.setAttribute(name, value)
    }
    inline.append(...block.childNodes)
    block.replaceWith(inline)
  }
  // The library sizes a legacy (VML) drawing by measuring it after it renders, which finds no layout here and gives
  // 0, and Chromium paints nothing in an empty box. Without that size the drawing keeps its box from CSS, and the
  // snapshot's style lets it show past the box.
  for (const drawing of wrapper.querySelectorAll('svg')) {
    drawing.removeAttribute('width')
    drawing.removeAttribute('height')
  }
}

/**
 * Renders a DOCX into a static page for a frame with `sandbox=""`, whose policy loads nothing outside it. Links lose
 * their targets: a snapshot cannot follow them. A file the renderer cannot read, damaged or using something it does not
 * handle, gets a refusal like one past the limits, so Download still works.
 */
export const renderDocxSnapshot = async (blob: Blob): Promise<DocxSnapshot> => {
  try {
    const { styles, wrapper } = await renderPages(await unpackWithinLimits(blob))
    prepareForMarkup(wrapper)
    const html =
      `<!DOCTYPE html><html><head><meta http-equiv="Content-Security-Policy" content="${snapshotPolicy}">` +
      '<style>body { margin: 0; background: gray; } svg { overflow: visible; }</style>' +
      `${styles.map(styleMarkup).join('')}</head><body>${wrapper.outerHTML}</body></html>`
    return { kind: 'pages', html, width: pagesWidth(wrapper) }
  } catch (error) {
    if (error instanceof PastLimitsError) {
      return { kind: 'tooLarge' }
    }
    console.error('[docx preview] Could not render the document', error)
    return { kind: 'unreadable' }
  }
}
