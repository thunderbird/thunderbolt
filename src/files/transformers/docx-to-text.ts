/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { strFromU8, zipSync } from 'fflate'
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

/** Word's namespaces are under 80 characters. The reader copies an element's namespace into its name, every time. */
const maxNamespaceLength = 256

/**
 * The reader checks each new warning against every earlier one, so its time grows with the square of how many
 * differ. A warning names an element the reader skips, or quotes the attributes of an element in
 * {@link quotedInWarnings}. Normal documents have under 200 such names and values; 16,000 styles took Safari 8 s.
 */
const maxMarkupKinds = 1_000
const quotedInWarnings = new Set(['br', 'sym', 'pStyle', 'rStyle', 'tblStyle', 'Default', 'Override'])
const quotedAttributes = new Set(['type', 'char', 'font', 'val', 'ContentType'])

const limitMessages = {
  bytes: `This document's text unpacks to over ${maxUnpackedMib} MiB, the limit for reading it.`,
  parts: `This document has more than ${maxEntries} parts, over the limit for reading it.`,
}

// A tag cannot hold a `<`, not even quoted, so no match runs past the next one.
const startTags = /<([^\s/>!?<]+)((?:[^<>"']|"[^"]*"|'[^']*')*)>/g
const attributePattern = /([^\s=]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g

/** The name and value of each attribute in the text of a tag after its name. */
const attributesOf = (tagRest: string) =>
  [...tagRest.matchAll(attributePattern)].map(([, name, double, single]) => ({ name, value: double ?? single }))

const localName = (name: string) => name.slice(name.indexOf(':') + 1)
const prefixOf = (name: string) => name.slice(0, Math.max(name.indexOf(':'), 0))

/** Each prefix's namespace, refusing a namespace over the limit and a prefix given two, as the scan reads one per prefix. */
const namespacesOf = (xml: string) => {
  const namespaces = new Map<string, string>()
  for (const [, , rest] of xml.matchAll(startTags)) {
    for (const { name, value } of rest.includes('xmlns') ? attributesOf(rest) : []) {
      if (name !== 'xmlns' && !name.startsWith('xmlns:')) {
        continue
      }
      if (value.length > maxNamespaceLength) {
        throw new Error(
          `This document declares a namespace longer than ${maxNamespaceLength} characters, over the limit for reading it.`,
        )
      }
      const prefix = name.slice('xmlns:'.length)
      if ((namespaces.get(prefix) ?? value) !== value) {
        throw new Error('This document gives one namespace prefix two different namespaces, so it cannot be read.')
      }
      namespaces.set(prefix, value)
    }
  }
  return namespaces
}

/**
 * Adds to `kinds` an entry for each different warning the reader could write about the part: an element by its
 * namespace and name, or the quoted attributes of one in {@link quotedInWarnings}. Throws, with a message for the
 * model, past {@link maxMarkupKinds} and the namespace limits.
 */
const addMarkupKinds = (xml: string, kinds: Set<string>) => {
  const namespaces = namespacesOf(xml)
  for (const [, name, rest] of xml.matchAll(startTags)) {
    const local = localName(name)
    const namespace = namespaces.get(prefixOf(name))
    const quoted = quotedInWarnings.has(local)
      ? attributesOf(rest).filter((attribute) => quotedAttributes.has(localName(attribute.name)))
      : []
    kinds.add(
      [namespace === undefined ? name : `{${namespace}}${local}`, ...quoted.map(({ value }) => value)].join(' '),
    )
    if (kinds.size > maxMarkupKinds) {
      throw new Error(`This document has over ${maxMarkupKinds} different kinds of markup, the limit for reading it.`)
    }
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

const relationshipTags = /<(?:[^\s/>!?<:]+:)?Relationship\s((?:[^<>"']|"[^"]*"|'[^']*')*)>/g
const relationshipType = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/'

/** Where the relationships of the part at `path` are kept. */
const relationshipsPath = (path: string) => path.replace(/[^/]*$/, (name) => `_rels/${name}.rels`)

/**
 * The parts the reader reads, found as it finds them: the package's, the main document's, and those the main document
 * relates to by type, each at its first target that exists or else at Word's usual path. `read` lists them in reading
 * order, a part read twice twice. Only these are unpacked, within the limits, so nothing else reaches the reader.
 */
const unpackTextParts = (zip: Uint8Array) => {
  const names = new Set<string>()
  const parts = new Map<string, Uint8Array>()
  const read: string[] = []
  const unpack = (paths: string[]) => {
    const used = [...parts.values()].reduce((total, part) => total + part.length, 0)
    const limits = { bytes: maxUnpackedMib * 1024 * 1024 - used, parts: maxEntries }
    const wanted = new Set(paths.filter((path) => !parts.has(path)))
    // Every name passes through `keep`, which notes which parts exist.
    const keep = (name: string) => {
      names.add(name)
      return wanted.has(name)
    }
    try {
      for (const [name, part] of unzipWithinLimits(zip, limits, keep)) {
        parts.set(name, part)
      }
    } catch (error) {
      throw error instanceof ZipLimitError ? new Error(limitMessages[error.limit]) : error
    }
    read.push(...paths.filter((path) => parts.has(path)))
  }
  const partPath = (from: string, type: string, fallback: string) => {
    // A target is relative to the folder of the part the relationships belong to.
    const dir = from.slice(0, Math.max(from.lastIndexOf('/_rels/'), 0))
    const targets = [...strFromU8(parts.get(from) ?? new Uint8Array()).matchAll(relationshipTags)]
      .map(([, rest]) => new Map(attributesOf(rest).map(({ name, value }) => [name, value])))
      .filter((attributes) => attributes.get('Type') === relationshipType + type)
      .map((attributes) => attributes.get('Target') ?? '')
    const paths = targets.map((target) =>
      (target.startsWith('/') || !dir ? target : `${dir}/${target}`).replace(/^\//, ''),
    )
    return paths.find((path) => names.has(path)) ?? fallback
  }

  unpack(['[Content_Types].xml', '_rels/.rels'])
  const main = partPath('_rels/.rels', 'officeDocument', 'word/document.xml')
  const mainRelationships = relationshipsPath(main)
  unpack([mainRelationships])
  const related = (type: string) => partPath(mainRelationships, type, `word/${type}.xml`)
  const withBodies = [related('footnotes'), related('endnotes'), related('comments'), main]
  unpack([related('styles'), related('numbering'), ...withBodies.flatMap((path) => [relationshipsPath(path), path])])
  return { parts, read }
}

/** The document as a zip of only its {@link unpackTextParts}. Throws, with a message for the model, past the limits. */
const textOnlyZip = (zip: Uint8Array) => {
  const { parts, read } = unpackTextParts(zip)
  const kinds = new Set<string>()
  for (const part of parts.values()) {
    addMarkupKinds(strFromU8(part), kinds)
  }
  if (readerMib(read.map((path) => parts.get(path) ?? new Uint8Array())) > maxReaderMib) {
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
