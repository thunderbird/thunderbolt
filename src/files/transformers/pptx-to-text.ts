/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { DOMParser, Element, type Node } from '@xmldom/xmldom'
import { strFromU8 } from 'fflate'
import { unzipWithinLimits, ZipLimitError } from '@/files/unzip-within-limits'
import type { StoredFile } from '@/lib/file-blob-storage'
import { resolvePart } from '@/office/formula-cache'

const ns = {
  p: 'http://schemas.openxmlformats.org/presentationml/2006/main',
  a: 'http://schemas.openxmlformats.org/drawingml/2006/main',
  r: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships',
  rels: 'http://schemas.openxmlformats.org/package/2006/relationships',
  mc: 'http://schemas.openxmlformats.org/markup-compatibility/2006',
}

type Parts = Map<string, Uint8Array>

const maxUnpackedMib = 32
// A classic zip stores its entry count in 16 bits; a forged ZIP64 count would keep the listing going.
const maxEntries = 65_535

const limitMessages = {
  bytes: `This presentation's text unpacks to over ${maxUnpackedMib} MiB, the limit for reading it.`,
  parts: `This presentation has more than ${maxEntries} parts, over the limit for reading it.`,
}

/** The deck's XML parts, the only ones with text. Throws, with a message for the model, past the limits. */
const unpackXmlParts = (zip: Uint8Array): Parts => {
  try {
    return unzipWithinLimits(
      zip,
      { bytes: maxUnpackedMib * 1024 * 1024, parts: maxEntries },
      (name) => name.startsWith('ppt/') && /\.(?:xml|rels)$/.test(name),
    )
  } catch (error) {
    throw error instanceof ZipLimitError ? new Error(limitMessages[error.limit]) : error
  }
}

const parseXml = (parts: Parts, path: string) => {
  const bytes = parts.get(path)
  return bytes && new DOMParser().parseFromString(strFromU8(bytes), 'text/xml').documentElement
}

/** The parts a part's relationships point to, with each relationship's id and type. */
const relationships = (parts: Parts, part: string) => {
  const slash = part.lastIndexOf('/') + 1
  const rels = parseXml(parts, `${part.slice(0, slash)}_rels/${part.slice(slash)}.rels`)
  return [...(rels?.getElementsByTagNameNS(ns.rels, 'Relationship') ?? [])].map((rel) => ({
    id: rel.getAttribute('Id'),
    type: rel.getAttribute('Type') ?? '',
    target: resolvePart(part, rel.getAttribute('Target') ?? ''),
  }))
}

/** The nearest element around a node with the given namespace and name, or `undefined` when there is none. */
const enclosing = (node: Node | null, namespace: string, name: string): Element | undefined => {
  if (!node) {
    return undefined
  }
  return node instanceof Element && node.namespaceURI === namespace && node.localName === name
    ? node
    : enclosing(node.parentNode, namespace, name)
}

/** The child of `parent` with the given namespace and name. */
const child = (parent: Element | undefined, namespace: string, name: string) =>
  [...(parent?.children ?? [])].find((el) => el.namespaceURI === namespace && el.localName === name)

/** The type of a text box's placeholder, such as `title` or `body`, or `undefined` when it is not one. */
const placeholderType = (textBox?: Element) => {
  const placeholder = child(child(child(textBox, ns.p, 'nvSpPr'), ns.p, 'nvPr'), ns.p, 'ph')
  return placeholder ? (placeholder.getAttribute('type') ?? 'body') : undefined
}

/** A paragraph's text: its runs and fields, with line breaks. */
const paragraphText = (paragraph: Element) =>
  [...paragraph.getElementsByTagNameNS(ns.a, '*')]
    .map((el) => (el.localName === 't' ? el.textContent : el.localName === 'br' ? '\n' : ''))
    .join('')
    .trim()

/** A table row as one line, its cells separated by tabs. Empty cells keep their place, so columns stay aligned. */
const rowText = (row: Element) => {
  const cells = [...row.children]
    .filter((cell) => cell.namespaceURI === ns.a && cell.localName === 'tc')
    .map((cell) => [...cell.getElementsByTagNameNS(ns.a, 'p')].map(paragraphText).filter(Boolean).join(' '))
  return cells.some(Boolean) ? cells.join('\t') : ''
}

/**
 * A slide or notes page's lines in reading order: each paragraph with the type of placeholder it sits in, and each
 * table row. Content a file gives twice, as a choice and as a fallback for older apps, counts once: the choice,
 * which is what the slide shows.
 */
const lines = (root?: Element | null) =>
  [...(root?.getElementsByTagNameNS(ns.a, '*') ?? [])]
    .filter((el) => el.localName === 'tr' || (el.localName === 'p' && !enclosing(el.parentNode, ns.a, 'tr')))
    .filter((el) => !enclosing(el, ns.mc, 'Fallback'))
    .map((el) =>
      el.localName === 'tr'
        ? { text: rowText(el), placeholder: undefined }
        : { text: paragraphText(el), placeholder: placeholderType(enclosing(el, ns.p, 'sp')) },
    )
    .filter(({ text }) => text !== '')

const isTitle = (placeholder?: string) => placeholder === 'title' || placeholder === 'ctrTitle'

/** Placeholders that repeat on every slide: its number, date, header and footer. */
const pageFurniture = new Set(['sldNum', 'dt', 'hdr', 'ftr'])

/** One slide as text: a heading with its number and title, its other text, then its speaker notes. */
const slideText = (parts: Parts, path: string, index: number, notesPath?: string) => {
  const content = lines(parseXml(parts, path))
  const title = content.filter(({ placeholder }) => isTitle(placeholder)).map(({ text }) => text)
  const body = content
    .filter(({ placeholder }) => !isTitle(placeholder) && !pageFurniture.has(placeholder ?? ''))
    .map(({ text }) => text)
  // A notes page's other placeholders hold the slide's picture and the page furniture.
  const notes = lines(notesPath ? parseXml(parts, notesPath) : undefined)
    .filter(({ placeholder }) => placeholder === 'body' || placeholder === undefined)
    .map(({ text }) => text)
  // A line break in a title would push the rest of it into the body.
  const heading =
    title.length > 0 ? `## Slide ${index + 1}: ${title.join(' ').replace(/\s*\n\s*/g, ' ')}` : `## Slide ${index + 1}`
  return [heading, ...body, ...(notes.length > 0 ? ['', 'Speaker notes:', ...notes] : [])].join('\n')
}

/**
 * Extracts a deck's text for the model: each slide in the order it is shown, with its title, its other text and its
 * speaker notes. Pictures, charts and diagrams carry no text here. Each part is read once, however many times the
 * deck lists it, so the text is never longer than the XML it comes from.
 */
export const pptxToText = async (file: StoredFile): Promise<{ text: string }> => {
  const parts = unpackXmlParts(new Uint8Array(await file.blob.arrayBuffer()))
  const presentation = 'ppt/presentation.xml'
  const targets = new Map(relationships(parts, presentation).map(({ id, target }) => [id, target]))
  const slides = new Set(
    [...(parseXml(parts, presentation)?.getElementsByTagNameNS(ns.p, 'sldId') ?? [])]
      .map((slide) => targets.get(slide.getAttributeNS(ns.r, 'id')))
      .filter((path) => path !== undefined),
  )
  if (slides.size === 0) {
    throw new Error('This presentation has no slides that could be read.')
  }
  const readNotes = new Set<string>()
  const text: string[] = []
  for (const path of slides) {
    const notes = relationships(parts, path).find(({ type }) => type.endsWith('/notesSlide'))?.target
    const unread = notes && !readNotes.has(notes) ? notes : undefined
    if (unread) {
      readNotes.add(unread)
    }
    text.push(slideText(parts, path, text.length, unread))
  }
  return { text: text.join('\n\n') }
}
