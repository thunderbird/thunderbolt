/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { zipSync } from 'fflate'
import { unzipWithinLimits, ZipLimitError } from '@/files/unzip-within-limits'
import type { StoredFile } from '@/lib/file-blob-storage'

const maxUnpackedMib = 4
// A classic zip stores its entry count in 16 bits; a forged ZIP64 count would keep the listing going.
const maxEntries = 65_535

/**
 * What the reader holds per element and per attribute, in KiB, as measured in Safari. Its memory follows the markup,
 * not the bytes: 1 MiB of empty paragraphs peaks near 0.6 GiB, 16 MiB of plain prose near 0.5 GiB. Under these
 * limits, crafted documents peaked near 0.4 GiB.
 */
const readerKib = { element: 4, attribute: 0.4 }
const maxReaderMib = 400

const limitMessages = {
  bytes: `This document's text unpacks to over ${maxUnpackedMib} MiB, the limit for reading it.`,
  parts: `This document has more than ${maxEntries} parts, over the limit for reading it.`,
}

/** The XML and relationship parts, the ones the text is read from; pictures and other media stay packed. */
const unpackXmlParts = (zip: Uint8Array) => {
  try {
    return unzipWithinLimits(zip, { bytes: maxUnpackedMib * 1024 * 1024, parts: maxEntries }, (name) =>
      /\.(?:xml|rels)$/i.test(name),
    )
  } catch (error) {
    throw error instanceof ZipLimitError ? new Error(limitMessages[error.limit]) : error
  }
}

/**
 * The reader's memory for the parts, in MiB. Each `<` that does not close a tag opens an element, and each `=` may
 * set an attribute. Text can hold a `<` only escaped, so no element is missed; a `=` in text only adds to the count.
 */
const readerMib = (parts: Iterable<Uint8Array>) => {
  let elements = 0
  let attributes = 0
  for (const part of parts) {
    for (let at = 0; at < part.length; at++) {
      if (part[at] === 0x3c && part[at + 1] !== 0x2f) {
        elements++
      } else if (part[at] === 0x3d) {
        attributes++
      }
    }
  }
  return (elements * readerKib.element + attributes * readerKib.attribute) / 1024
}

/** The document as a zip of only its {@link unpackXmlParts}. Throws, with a message for the model, past the limits. */
const textOnlyZip = (zip: Uint8Array) => {
  const parts = unpackXmlParts(zip)
  if (readerMib(parts.values()) > maxReaderMib) {
    throw new Error(
      `Reading this document's text would take over ${maxReaderMib} MiB of memory, the limit for reading it.`,
    )
  }
  // Stored, not deflated: the reader would only inflate the parts again.
  return zipSync(Object.fromEntries(parts), { level: 0 })
}

/**
 * Extracts plain text from a DOCX blob via a lazily-imported mammoth: the
 * model wants prose, not markup, so we use mammoth's raw-text path. The
 * preview renders the pages with docx-preview instead.
 */
export const docxToText = async (file: StoredFile): Promise<{ text: string }> => {
  const mammoth = await import('mammoth')
  const zip = textOnlyZip(new Uint8Array(await file.blob.arrayBuffer()))
  const result = await mammoth.extractRawText({ arrayBuffer: zip.buffer })
  return { text: result.value.trim() }
}
