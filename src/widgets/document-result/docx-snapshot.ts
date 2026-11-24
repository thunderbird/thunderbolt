/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { defaultOptions, type Options, parseAsync, renderDocument } from 'docx-preview'
import { zipSync } from 'fflate'
import { type DocumentSnapshot, PastLimitsError, renderSnapshot, snapshotLimits, unpackWithinLimits } from './snapshot'

/** Past any limit the preview is refused. At these limits every measured preview painted in under a second. */
export const docxPreviewLimits = {
  ...snapshotLimits,
  /** What `word/document.xml` unpacks to. 3.5 MB is about 1,000 pages. */
  documentXmlBytes: 3_500_000,
}

/** The padding the renderer's wrapper puts on each side of the pages. */
const wrapperPadding = 30

/** US Letter, for a document whose pages give no width: the thumbnail still needs one to scale to. */
const letterWidthPt = 612

/** The document's parts within the limits, stored again without compression for the renderer. */
const partsWithinLimits = async (blob: Blob) => {
  const parts = await unpackWithinLimits(blob)
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
  ['\uF0B7', '\u2022'], // Symbol bullet: •
  ['\uF0A7', '\u25AA'], // Wingdings small square: ▪
  ['\uF06E', '\u25A0'], // Wingdings square: ■
  ['\uF076', '\u2756'], // Wingdings diamond: ❖
  ['\uF0D8', '\u27A2'], // Wingdings arrowhead: ➢
  ['\uF0FC', '\u2713'], // Wingdings check mark: ✓
])
const fontBulletPattern = new RegExp(`[${[...fontBullets.keys()].join('')}]`, 'g')

/**
 * In a right-to-left paragraph, Word reads `left` and `right` alignment as start and end, so `left` lands on the
 * right. The library writes them as CSS `left` and `right`, which puts Arabic and Hebrew text on the wrong side.
 */
const edgeAlignment = (css: string) =>
  css.replace(/text-align: (left|right)/g, (_, side) => `text-align: ${side === 'left' ? 'start' : 'end'}`)

/** The CSS with each right-to-left rule's alignment as {@link edgeAlignment} gives it. */
const rightToLeftRules = (css: string) =>
  css.replace(/\{[^}]*\}/g, (rule) => (rule.includes('direction: rtl') ? edgeAlignment(rule) : rule))

/**
 * A style element's text, with `<` escaped as CSS reads it, so text from the file cannot close the element, with
 * Word's bullets as characters every platform draws, and with right-to-left paragraphs aligned as Word aligns them.
 */
const styleMarkup = (style: HTMLStyleElement) => {
  const css = rightToLeftRules((style.textContent ?? '').replaceAll('<', '\\3c '))
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

/**
 * Whether the library's CSS makes a paragraph right-to-left through its paragraph style, which the library has merged
 * with the styles it is based on, or through the default paragraph style. The library never writes `direction: ltr`,
 * so any of these rules wins.
 */
const rightToLeftByStyle = (css: string) => {
  const selectors = [...css.matchAll(/([^{}]*)\{[^}]*direction: rtl/g)].flatMap(([, list]) =>
    list.split(',').map((selector) => selector.trim()),
  )
  const classes = new Set(selectors.flatMap((selector) => /^p\.(\S+)$/.exec(selector)?.[1] ?? []))
  const everyParagraph = selectors.includes('.docx p')
  return (paragraph: Element) => everyParagraph || [...paragraph.classList].some((name) => classes.has(name))
}

/**
 * Changes what would not survive as static markup: links, pictures in paragraphs, and the size of legacy drawings.
 * Aligns right-to-left paragraphs as Word does, whether the paragraph or its style sets the direction.
 */
const prepareForMarkup = (wrapper: HTMLDivElement, css: string) => {
  for (const link of wrapper.querySelectorAll('a[href]')) {
    link.removeAttribute('href')
  }
  const styledRightToLeft = rightToLeftByStyle(css)
  for (const element of wrapper.querySelectorAll('[style*="direction: rtl"], p[style*="text-align"]')) {
    if (element.matches('[style*="direction: rtl"]') || styledRightToLeft(element)) {
      element.setAttribute('style', edgeAlignment(element.getAttribute('style') ?? ''))
    }
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
 * On a phone, in a frame narrower than the pages, each page takes the frame's width and its text wraps to it at the
 * size the document sets. Scaled down to a phone's width instead, its text would be about 5 pixels tall. A picture
 * shrinks to fit; a table too wide scrolls across its page.
 */
const reflowStyle = (width: number) =>
  `<style>@media (max-width: ${width - 1}px) {` +
  '.docx-wrapper { padding: 8px 8px 0 !important; align-items: stretch !important; }' +
  '.docx-wrapper > section.docx { width: auto !important; min-height: 0 !important; padding: 24px 16px !important;' +
  ' margin-bottom: 8px !important; overflow-x: auto !important; }' +
  '.docx img { max-width: 100%; height: auto !important; }' +
  '}</style>'

/**
 * Renders a DOCX into a static page for a frame with `sandbox=""`, whose policy loads nothing outside it. Links lose
 * their targets: a snapshot cannot follow them. Its pages can reflow in a frame narrower than they are.
 */
export const renderDocxSnapshot = (blob: Blob): Promise<DocumentSnapshot> =>
  renderSnapshot('docx preview', async () => {
    const { styles, wrapper } = await renderPages(await partsWithinLimits(blob))
    prepareForMarkup(wrapper, styles.map((style) => style.textContent).join(''))
    const width = pagesWidth(wrapper)
    return {
      head:
        '<style>body { margin: 0; background: gray; } svg { overflow: visible; }</style>' +
        styles.map(styleMarkup).join(''),
      body: wrapper.outerHTML,
      width,
      reflowStyle: reflowStyle(width),
    }
  })
