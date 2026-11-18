/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import {
  buildPresentation,
  parseZip,
  renderSlide,
  type SlideHandle,
  type SlideRendererOptions,
} from '@aiden0z/pptx-renderer/browser'
import { zipSync } from 'fflate'
import { blobToBase64 } from '@/lib/attachments'
import {
  type DocumentSnapshot,
  PastLimitsError,
  renderSnapshot,
  snapshotLimits,
  snapshotPolicy,
  unpackWithinLimits,
} from './snapshot'

/** Past any limit the preview is refused. A snapshot renders every slide: 200 painted in about a second. */
export const pptxPreviewLimits = {
  ...snapshotLimits,
  slides: 200,
  /**
   * The characters the slides' markup may hold. A picture on the master or layout is copied into every slide's
   * markup, so a 2 MB background on 200 slides came to half a billion characters and gigabytes of memory.
   */
  markupChars: 32 * 1024 * 1024,
}

/**
 * A counter of the slides' markup, made from each element's tag, attributes and text without building the markup.
 * The count is a floor of the markup's length, and the counter refuses the deck as soon as it passes
 * {@link pptxPreviewLimits.markupChars}.
 */
const markupCounter = () => {
  const left = { chars: pptxPreviewLimits.markupChars }
  const spend = (chars: number) => {
    left.chars -= chars
    if (left.chars < 0) {
      throw new PastLimitsError()
    }
  }
  return (slide: HTMLElement) => {
    spend(slide.textContent?.length ?? 0)
    for (const element of [slide, ...slide.querySelectorAll('*')]) {
      // `<tag>` and `</tag>`, then ` name="value"` for each attribute.
      spend(element.tagName.length * 2 + 5)
      for (const { name, value } of element.attributes) {
        spend(name.length + value.length + 4)
      }
    }
  }
}

/** The space around and between slides, in CSS pixels. */
const gap = 16

/** Picture types a browser draws, by extension. The snapshot embeds these; any other media stays blocked. */
const pictureTypes = new Map([
  ['png', 'image/png'],
  ['jpg', 'image/jpeg'],
  ['jpeg', 'image/jpeg'],
  ['gif', 'image/gif'],
  ['bmp', 'image/bmp'],
  ['webp', 'image/webp'],
  ['svg', 'image/svg+xml'],
])

/**
 * The deck's pictures as `data:` URLs, by their path in the file. Handed to the renderer as its media cache, they
 * take the place of the `blob:` URLs it would make, which the snapshot's policy blocks.
 */
const pictureUrls = async (media: Map<string, Uint8Array>) => {
  const urls = new Map<string, string>()
  for (const [path, bytes] of media) {
    const type = pictureTypes.get(path.split('.').pop()?.toLowerCase() ?? '')
    if (type) {
      urls.set(path, `data:${type};base64,${await blobToBase64(new Blob([new Uint8Array(bytes)]))}`)
    }
  }
  return urls
}

/** Resolves on the page's next animation frame, when the renderer starts the charts it has queued. */
const nextFrame = () => new Promise((resolve) => requestAnimationFrame(resolve))

/**
 * A hidden frame, laid out at the slides' width, whose document has the snapshot's policy and runs no script. The
 * renderer builds its elements in this page's document, but they load only once they are laid out, and laid out in
 * this frame nothing outside the file loads, including a URL the file slips into the CSS the renderer writes.
 */
const openRenderFrame = async (width: number) => {
  const frame = document.createElement('iframe')
  frame.sandbox.add('allow-same-origin')
  frame.style.cssText = `position: fixed; left: -100000px; top: 0; width: ${width}px; height: 100px; visibility: hidden`
  frame.srcdoc = `<!DOCTYPE html><meta http-equiv="Content-Security-Policy" content="${snapshotPolicy}"><body></body>`
  const loaded = new Promise((resolve) => frame.addEventListener('load', resolve, { once: true }))
  document.body.append(frame)
  await loaded
  return frame
}

/**
 * Runs `render` with `document.body` standing for `body`. While it builds a slide, the renderer attaches it to
 * `document.body` to measure its text, and laid out in this page the slide would load any URL the file slips into
 * the CSS the renderer writes. Laid out in the frame's body, it loads only what the frame's policy allows. The
 * renderer builds a slide synchronously, so no other code sees the stand-in.
 */
const withBody = <T>(body: HTMLElement, render: () => T): T => {
  Object.defineProperty(document, 'body', { configurable: true, get: () => body })
  try {
    return render()
  } finally {
    // Deleting the stand-in brings back the document's own `body`.
    Reflect.deleteProperty(document, 'body')
  }
}

/** Swaps each canvas, which a chart draws on, for a picture of it: a canvas copied as markup is blank. */
const canvasesToPictures = (slide: HTMLElement) => {
  for (const canvas of slide.querySelectorAll('canvas')) {
    const picture = document.createElement('img')
    picture.src = canvas.toDataURL('image/png')
    picture.style.cssText = canvas.style.cssText
    canvas.replaceWith(picture)
  }
}

/**
 * Removes link targets, which would not survive as static markup, and lets a table show every row. The renderer clips
 * a table to its frame, while PowerPoint grows the rows to fit their text, so a table whose rows have no height would
 * lose its last rows.
 */
const prepareForMarkup = (slide: HTMLElement) => {
  for (const link of slide.querySelectorAll('a[href]')) {
    link.removeAttribute('href')
  }
  for (const table of slide.querySelectorAll('table')) {
    table.parentElement?.style.setProperty('overflow', 'visible')
  }
}

const drawingNs = 'http://schemas.openxmlformats.org/drawingml/2006/main'

/** Half a turn and a full turn, in the 60,000ths of a degree a slide gives angles in. */
const halfTurn = 10_800_000
const fullTurn = 2 * halfTurn

const isTrue = (value: string | null) => value === '1' || value === 'true'

/** The node's first child element with the local name, whatever its prefix. */
const childElement = (parent: Node, name: string) =>
  [...parent.childNodes].find(
    (node): node is Element => node.nodeType === Node.ELEMENT_NODE && node.nodeName.split(':').pop() === name,
  )

/**
 * Rewrites a slide's XML, in place, where the renderer draws it unlike PowerPoint, into XML that means the same:
 * - Each paragraph of a numbered list carries the number the list starts at, and the renderer shows that number on
 *   every one, so a list reads "1., 1.". Only a paragraph whose number differs from the one before keeps it, because
 *   the list starts or restarts there; the rest count on.
 * - A shape flipped both ways looks the same as one turned half a turn, but the renderer mirrors its text, so the
 *   flips become a half turn.
 */
export const matchPowerPoint = (slide: Document) => {
  for (const body of slide.getElementsByTagNameNS('*', 'txBody')) {
    const listStarts = new Map<string, string | null>()
    for (const paragraph of body.childNodes) {
      const props = childElement(paragraph, 'pPr')
      const number = props && childElement(props, 'buAutoNum')
      if (!number) {
        continue
      }
      const list = `${props.getAttribute('lvl') ?? 0}:${number.getAttribute('type') ?? 'arabicPeriod'}`
      const start = number.getAttribute('startAt')
      // A number that differs from the paragraph before is a restart, so it stays.
      if (listStarts.get(list) === start) {
        number.removeAttribute('startAt')
      }
      listStarts.set(list, start)
    }
  }
  for (const transform of slide.getElementsByTagNameNS(drawingNs, 'xfrm')) {
    // A group's flips also move its children, so only a shape's own are rewritten.
    if (transform.parentNode?.nodeName.split(':').pop() !== 'spPr') {
      continue
    }
    if (isTrue(transform.getAttribute('flipH')) && isTrue(transform.getAttribute('flipV'))) {
      transform.setAttribute('rot', String((Number(transform.getAttribute('rot') ?? 0) + halfTurn) % fullTurn))
      transform.removeAttribute('flipH')
      transform.removeAttribute('flipV')
    }
  }
}

/** Each slide's XML put through {@link matchPowerPoint}. */
const slidesMatchingPowerPoint = (slides: Map<string, string>) =>
  new Map(
    [...slides].map(([path, xml]) => {
      const slide = new DOMParser().parseFromString(xml, 'application/xml')
      matchPowerPoint(slide)
      return [path, new XMLSerializer().serializeToString(slide)]
    }),
  )

/**
 * Renders every slide of a PPTX into a static page for a frame with `sandbox=""`. The renderer lays the slides out in
 * a hidden frame of this page, because text fitting and charts need layout, and fetches no media from outside the
 * file. Charts become pictures; video, audio and links do not work in a snapshot.
 */
export const renderPptxSnapshot = (blob: Blob): Promise<DocumentSnapshot> =>
  renderSnapshot('pptx preview', async () => {
    // The parts are already unpacked within the limits and stored, so the renderer's own zip limits add nothing.
    const parts = zipSync(await unpackWithinLimits(blob), { level: 0 })
    const files = await parseZip(parts.buffer)
    const presentation = buildPresentation(
      { ...files, slides: slidesMatchingPowerPoint(files.slides) },
      { lazySlides: true },
    )
    if (presentation.slides.length > pptxPreviewLimits.slides) {
      throw new PastLimitsError()
    }
    // A deck with no slides, or a zip that is no deck, would show an empty frame.
    if (presentation.slides.length === 0) {
      throw new Error('The deck has no slides')
    }
    const mediaUrls = await pictureUrls(files.media)
    const charts: NonNullable<SlideRendererOptions['chartInstances']> = new Set()
    const options: SlideRendererOptions = {
      externalMedia: 'block',
      // The PDF fallback for EMF pictures starts `blob:` Workers.
      pdfjs: false,
      // The renderer adds a `blob:` URL here for audio and video, and leaves revoking it to the cache's owner.
      mediaUrlCache: mediaUrls,
      chartInstances: charts,
      // Fonts load into this page, not the snapshot's, so the snapshot could not use them.
      embeddedFontLimits: { maxFaces: 0 },
    }
    const handles: SlideHandle[] = []
    const frame = await openRenderFrame(presentation.width)
    try {
      const host = frame.contentDocument!.body
      // Counted as each slide renders, so a deck far past the limit stops early.
      const countRendered = markupCounter()
      for (const slide of presentation.slides) {
        const handle = withBody(host, () => renderSlide(presentation, slide, options))
        handles.push(handle)
        host.append(handle.element)
        countRendered(handle.element)
      }
      await Promise.all(handles.map(({ ready }) => ready))
      // Charts start in the next frame. Without animation each draws its final state at once.
      await nextFrame()
      for (const chart of charts) {
        chart.setOption({ animation: false })
      }
      await nextFrame()
      const elements = handles.map(({ element }) => element)
      for (const element of elements) {
        canvasesToPictures(element)
        prepareForMarkup(element)
      }
      // Counted again once charts are pictures, before any markup is built.
      elements.forEach(markupCounter())
      const slides = elements.map((element) => element.outerHTML)
      return {
        head: `<style>body { margin: 0; padding: ${gap}px; background: gray; } body > * { margin: 0 auto ${gap}px; }</style>`,
        body: slides.join(''),
        // Slides place each shape at a fixed point, so they have no reflow style: they only scale.
        width: presentation.width + 2 * gap,
      }
    } finally {
      for (const handle of handles) {
        handle.dispose()
      }
      frame.remove()
      for (const url of mediaUrls.values()) {
        if (url.startsWith('blob:')) {
          URL.revokeObjectURL(url)
        }
      }
    }
  })
