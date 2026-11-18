/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { unzipWithinLimits, ZipLimitError } from '@/files/unzip-within-limits'
import { maxPicturePixels, rasterPixels } from '@/office/raster-pixels'
import { rasterType } from '@/office/raster-type'

const mib = 1024 * 1024

/** Past any limit a DOCX or PPTX preview is refused. At these limits every measured preview painted in under a second. */
export const snapshotLimits = {
  fileBytes: 10 * mib,
  /**
   * What all the parts together may unpack to. Pictures barely compress, so a file at the size limit unpacks to little
   * more than its size; this stops a small file that would unpack to gigabytes.
   */
  unzipBytes: 32 * mib,
  /** The most parts a classic zip lists. A ZIP64 directory can claim more than it holds. */
  parts: 65_535,
  /** The most pixels the file's pictures decode to, as a workbook's sheet allows. A picture past it is left out. */
  picturePixels: maxPicturePixels,
}

/** A transparent GIF of one pixel, drawn in place of a picture left out. */
const blankPicture = Uint8Array.from(atob('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7'), (char) =>
  char.charCodeAt(0),
)

/** An empty SVG, drawn in place of an SVG left out. */
const blankSvg = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"/>')

/** A part's text as a browser reads an SVG: UTF-16 when its first bytes say so, UTF-8 otherwise. */
const partText = (data: Uint8Array) => {
  const [first, second] = data
  if ((first === 0xff && second === 0xfe) || (first === 0x3c && second === 0)) {
    return new TextDecoder('utf-16le').decode(data)
  }
  if ((first === 0xfe && second === 0xff) || (first === 0 && second === 0x3c)) {
    return new TextDecoder('utf-16be').decode(data)
  }
  return new TextDecoder().decode(data)
}

/**
 * Whether a part is an SVG that could embed a picture: a `data:` URL, or a character reference, an entity or a CSS
 * escape that could spell one. The pixel count cannot see such a picture, so it could decode to any size. The vector
 * drawings Office writes contain none of these.
 */
const isSvgWithPicture = (data: Uint8Array) => {
  const text = partText(data)
  // A URL drops tabs and line breaks wherever they are.
  return /<([\w.-]+:)?svg[\s/>]/.test(text) && /data:|&#|<!entity|\\/i.test(text.replace(/[\t\n\r]/g, ''))
}

/**
 * The parts, with blanks in place of each SVG that could embed a picture and each raster picture that gives no size
 * in its header or would take the total past {@link snapshotLimits.picturePixels}, counted in zip order. A few
 * kilobytes of picture can claim a gigabyte of bitmap.
 */
const withinPictureLimit = (parts: Map<string, Uint8Array>) => {
  const pixels = { left: snapshotLimits.picturePixels }
  return [...parts].map(([name, data]): [string, Uint8Array] => {
    if (!rasterType(data)) {
      return [name, isSvgWithPicture(data) ? blankSvg : data]
    }
    const picture = rasterPixels(data) ?? Infinity
    if (picture > pixels.left) {
      return [name, blankPicture]
    }
    pixels.left -= picture
    return [name, data]
  })
}

/**
 * A file's pages or slides as markup for the sandboxed frame, with their width in CSS pixels, or why there are none:
 * past the limits, unreadable, or the renderer's code did not load, as on a broken network. In a frame narrower than
 * they are, the pages scale down to its width. Pages with a `reflowStyle`, added after the markup, lay their text out
 * again at the frame's width instead.
 */
export type DocumentSnapshot =
  | { kind: 'pages'; html: string; width: number; reflowStyle?: string }
  | { kind: 'tooLarge' }
  | { kind: 'unreadable' }
  | { kind: 'notLoaded' }

/** Thrown for a file past one of the preview's limits. */
export class PastLimitsError extends Error {}

/** A part's name as the renderers' zip reader (JSZip) resolves it, applying `.`, `..` and empty segments. */
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

/**
 * The file's parts by the name its renderer resolves, unpacked within {@link snapshotLimits}. The renderers' zip reader
 * (JSZip) unpacks a part in full before it compares it with the size the zip declares, so they only get parts unpacked
 * here first, each stopped at the size it declares, and stored again without compression.
 */
export const unpackWithinLimits = async (blob: Blob): Promise<Record<string, Uint8Array>> => {
  if (blob.size > snapshotLimits.fileBytes) {
    throw new PastLimitsError()
  }
  const parts = unzipWithinLimits(new Uint8Array(await blob.arrayBuffer()), {
    bytes: snapshotLimits.unzipBytes,
    parts: snapshotLimits.parts,
  })
  // A later part with the same resolved name replaces an earlier one, as in the zip reader.
  return Object.fromEntries(withinPictureLimit(parts).map(([name, data]) => [resolvePartName(name), data]))
}

/** The snapshot's own policy: its styles, and pictures and fonts embedded as `data:` URLs. Nothing else loads. */
export const snapshotPolicy = "default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:"

/**
 * The frame's width (the root's, without its scroll bar) divided by `width`. `tan(atan2(a, b))` gives `a / b` as a
 * plain number.
 */
const fitZoom = (width: number) => `min(1, tan(atan2(100cqw, ${width}px)))`

/**
 * Keeps pages that are `width` CSS pixels wide within the frame, added after the markup where {@link pagesZoomToFit}
 * holds. CSS `zoom` lays them out again at that size, so a thin border still covers a whole device pixel; Firefox
 * drops such a border from a frame scaled with `transform`.
 */
export const fitStyle = (width: number) =>
  `<style>html { container-type: inline-size; } body { zoom: ${fitZoom(width)}; }</style>`

/**
 * WebKit at 3 device pixels per CSS pixel, as on an iPhone, drops a collapsed table border thinner than 2 device
 * pixels: a document's default 0.5pt border at full size, and thin borders on pages drawn smaller with zoom or with
 * `transform`. On a screen that dense, tables get separate borders, which it draws. The renderers set
 * `border-collapse` on the table itself, hence `!important`; a table's own cell spacing is kept.
 */
const denseScreenStyle =
  '<style>@media (min-resolution: 3dppx) { table { border-collapse: separate !important; border-spacing: 0; } }</style>'

/**
 * Whether {@link fitStyle} draws pages smaller as they are, measured on a block 400px wide in a container 100px wide,
 * holding a line of 20px text. Checking the syntax is not enough. Safari 26 parses the zoom and computes it wrong,
 * and holds zoomed text to at least 9px, which lays the pages' text out again bigger than the rest of the page.
 * Safari before 16 lacks container units. Where the block is not drawn 100px wide with a line 5px tall, the frame
 * keeps the pages' width and is drawn smaller with `transform`. Lays out a hidden element, so call it once per view.
 */
export const pagesZoomToFit = () => {
  const container = document.createElement('div')
  container.style.cssText = 'position: absolute; visibility: hidden; width: 100px; container-type: inline-size'
  const block = container.appendChild(document.createElement('div'))
  block.style.cssText = `width: 400px; zoom: ${fitZoom(400)}`
  const line = block.appendChild(document.createElement('div'))
  line.style.cssText = 'font: 20px/1 serif'
  line.textContent = 'x'
  document.body.append(container)
  const { width } = block.getBoundingClientRect()
  const { height } = line.getBoundingClientRect()
  container.remove()
  return Math.round(width) === 100 && Math.round(height) === 5
}

/**
 * Renders a file into a static page for a frame with `sandbox=""`, whose policy loads nothing outside it. `render`
 * returns the page's head and body, its width in CSS pixels, and the style that makes the pages reflow, if they can.
 * A file past the limits gets `tooLarge`; one the renderer cannot read, damaged or using something it does not handle,
 * gets `unreadable`. Download works for both.
 */
export const renderSnapshot = async (
  label: string,
  render: () => Promise<{ head: string; body: string; width: number; reflowStyle?: string }>,
): Promise<DocumentSnapshot> => {
  try {
    const { head, body, width, reflowStyle } = await render()
    const html =
      `<!DOCTYPE html><html><head><meta http-equiv="Content-Security-Policy" content="${snapshotPolicy}">` +
      `${denseScreenStyle}${head}</head><body>${body}</body></html>`
    return { kind: 'pages', html, width, reflowStyle }
  } catch (error) {
    if (error instanceof PastLimitsError || error instanceof ZipLimitError) {
      return { kind: 'tooLarge' }
    }
    console.error(`[${label}] Could not render the file`, error)
    return { kind: 'unreadable' }
  }
}
