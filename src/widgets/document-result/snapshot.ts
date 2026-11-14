/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { unzipWithinLimits, ZipLimitError } from '@/files/unzip-within-limits'

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
}

/** A file's pages or slides as markup for the sandboxed frame, with their width in CSS pixels, or why there are none. */
export type DocumentSnapshot =
  | { kind: 'pages'; html: string; width: number }
  | { kind: 'tooLarge' }
  | { kind: 'unreadable' }

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
  return Object.fromEntries([...parts].map(([name, data]) => [resolvePartName(name), data]))
}

/** The snapshot's own policy: its styles, and pictures and fonts embedded as `data:` URLs. Nothing else loads. */
export const snapshotPolicy = "default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:"

/**
 * Renders a file into a static page for a frame with `sandbox=""`, whose policy loads nothing outside it. `render`
 * returns the page's head and body and its width. A file past the limits gets `tooLarge`; one the renderer cannot
 * read, damaged or using something it does not handle, gets `unreadable`. Download works for both.
 */
export const renderSnapshot = async (
  label: string,
  render: () => Promise<{ head: string; body: string; width: number }>,
): Promise<DocumentSnapshot> => {
  try {
    const { head, body, width } = await render()
    const html =
      `<!DOCTYPE html><html><head><meta http-equiv="Content-Security-Policy" content="${snapshotPolicy}">` +
      `${head}</head><body>${body}</body></html>`
    return { kind: 'pages', html, width }
  } catch (error) {
    if (error instanceof PastLimitsError || error instanceof ZipLimitError) {
      return { kind: 'tooLarge' }
    }
    console.error(`[${label}] Could not render the file`, error)
    return { kind: 'unreadable' }
  }
}
