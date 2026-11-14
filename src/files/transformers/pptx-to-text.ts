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
/**
 * The deepest an XML part may nest. PowerPoint writes a few dozen levels. xmldom's parsing slows with the square of
 * the depth when each level declares a namespace, so a deeper part is refused before it is parsed.
 */
const maxDepth = 256

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

/** Where the markup that starts at `at` ends: a comment, CDATA, a processing instruction, or a tag or declaration. */
const endOfMarkup = (xml: string, at: number) => {
  for (const [open, close] of [
    ['<!--', '-->'],
    ['<![CDATA[', ']]>'],
    ['<?', '?>'],
  ]) {
    if (xml.startsWith(open, at)) {
      const end = xml.indexOf(close, at + open.length)
      return end === -1 ? xml.length : end + close.length
    }
  }
  // A document type declaration can hold comments and quotes this scan would misread, and Office files have none.
  if (xml.startsWith('<!DOCTYPE', at)) {
    throw new Error('This presentation has a document type declaration, which it cannot have.')
  }
  // The first `>` outside a quoted attribute value, which can hold one. A `<` cannot appear in a tag, not even in
  // a quoted value; xmldom recovers from one by reading on, which would hide from this scan what it then parses.
  let quote = ''
  for (let index = at + 1; index < xml.length; index++) {
    const char = xml[index]
    if (char === '<') {
      throw new Error('This presentation has malformed XML.')
    }
    if (quote) {
      quote = char === quote ? '' : quote
    } else if (char === '"' || char === "'") {
      quote = char
    } else if (char === '>') {
      return index + 1
    }
  }
  return xml.length
}

/**
 * Throws when an XML part nests elements deeper than {@link maxDepth}, an empty element counting at its own depth.
 * One pass over the text, before any parsing. Every start tag counts, whatever its name, and a closing tag with
 * nothing open is refused, so the count cannot drift below what xmldom builds.
 */
const checkDepth = (xml: string) => {
  let depth = 0
  for (let at = xml.indexOf('<'); at !== -1; ) {
    const end = endOfMarkup(xml, at)
    const kind = xml[at + 1]
    if (kind === '/') {
      depth -= 1
      if (depth < 0) {
        throw new Error('This presentation has malformed XML.')
      }
    } else if (kind !== '!' && kind !== '?') {
      depth += 1
      if (depth > maxDepth) {
        throw new Error(`This presentation nests its content more than ${maxDepth} levels deep, too deep to read.`)
      }
      if (xml[end - 2] === '/') {
        depth -= 1
      }
    }
    at = xml.indexOf('<', end)
  }
}

/** A part's root element, once its depth has passed {@link checkDepth}, or `undefined` when the deck has no such part. */
const parseXml = (parts: Parts, path: string) => {
  const bytes = parts.get(path)
  if (!bytes) {
    return undefined
  }
  const xml = strFromU8(bytes)
  checkDepth(xml)
  return new DOMParser().parseFromString(xml, 'text/xml').documentElement ?? undefined
}

/** A part's relationships, with their targets as written, relative to the part. Resolve only the ones used. */
const relationships = (parts: Parts, part: string) => {
  const slash = part.lastIndexOf('/') + 1
  const rels = parseXml(parts, `${part.slice(0, slash)}_rels/${part.slice(slash)}.rels`)
  return [...(rels?.getElementsByTagNameNS(ns.rels, 'Relationship') ?? [])].map((rel) => ({
    id: rel.getAttribute('Id'),
    type: rel.getAttribute('Type') ?? '',
    target: rel.getAttribute('Target') ?? '',
  }))
}

/** Whether `node` is an element with the given namespace and local name. */
const isElement = (node: Node, namespace: string, name: string): node is Element =>
  node instanceof Element && node.namespaceURI === namespace && node.localName === name

/** Text and CDATA nodes. */
const textNodeTypes = new Set([3, 4])

/**
 * Visits `root` and everything inside it in document order, leaving out content a file gives as a fallback for
 * older apps: the slide shows the choice next to it. `visit` returns true to skip what is inside a node. The walk
 * keeps its own stack, so a deeply nested part cannot overflow the call stack.
 */
const walk = (root: Node, visit: (node: Node) => boolean) => {
  const stack = [root]
  while (stack.length > 0) {
    const node = stack.pop()!
    if (isElement(node, ns.mc, 'Fallback') || visit(node)) {
      continue
    }
    const children = [...node.childNodes]
    for (let index = children.length - 1; index >= 0; index--) {
      stack.push(children[index])
    }
  }
}

/** The text of a node's text and CDATA nodes, each read once. */
const textIn = (root: Node) => {
  const parts: string[] = []
  walk(root, (node) => {
    if (textNodeTypes.has(node.nodeType)) {
      parts.push(node.nodeValue ?? '')
    }
    return false
  })
  return parts.join('')
}

/**
 * A paragraph's text: its runs and fields, with line breaks. A run's text element owns all the text inside it, so
 * text a crafted file nests in several paragraphs or runs is read once, not once per level.
 */
const paragraphText = (paragraph: Element) => {
  const parts: string[] = []
  walk(paragraph, (node) => {
    if (isElement(node, ns.a, 't')) {
      parts.push(textIn(node))
      return true
    }
    if (isElement(node, ns.a, 'br')) {
      parts.push('\n')
    }
    return false
  })
  return parts.join('').trim()
}

/** The paragraphs inside `root`, each read once and none inside another. */
const paragraphsIn = (root: Element) => {
  const texts: string[] = []
  walk(root, (node) => {
    if (isElement(node, ns.a, 'p')) {
      texts.push(paragraphText(node))
      return true
    }
    return false
  })
  return texts.filter(Boolean)
}

/** A table row as one line, its cells separated by tabs. Empty cells keep their place, so columns stay aligned. */
const rowText = (row: Element) => {
  const cells = [...row.childNodes]
    .filter((node) => isElement(node, ns.a, 'tc'))
    .map((cell) => paragraphsIn(cell).join(' '))
  return cells.some(Boolean) ? cells.join('\t') : ''
}

/** The child of `parent` with the given namespace and name. */
const child = (parent: Element | undefined, namespace: string, name: string) =>
  [...(parent?.childNodes ?? [])].find((node): node is Element => isElement(node, namespace, name))

/** The type of a text box's placeholder, such as `title` or `body`, or `undefined` when it is not one. */
const placeholderType = (textBox: Element) => {
  const placeholder = child(child(child(textBox, ns.p, 'nvSpPr'), ns.p, 'nvPr'), ns.p, 'ph')
  return placeholder ? (placeholder.getAttribute('type') ?? 'body') : undefined
}

type Line = { text: string; placeholder?: string }

/**
 * A slide or notes page's lines in reading order: each paragraph, with the type of placeholder its text box is, and
 * each table row. One walk reads each part of the page once.
 */
const lines = (root?: Element) => {
  const found: Line[] = []
  const readScope = (scope: Element, placeholder?: string) =>
    walk(scope, (node) => {
      if (node !== scope && isElement(node, ns.p, 'sp')) {
        readScope(node, placeholderType(node))
        return true
      }
      if (isElement(node, ns.a, 'tr')) {
        found.push({ text: rowText(node) })
        return true
      }
      if (isElement(node, ns.a, 'p')) {
        found.push({ text: paragraphText(node), placeholder })
        return true
      }
      return false
    })
  if (root) {
    readScope(root)
  }
  return found.filter(({ text }) => text !== '')
}

/** Whether a placeholder type holds a slide's title. */
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
  // A line break in a title would push the rest of it into the body. Each run of white space is looked at once.
  const titleText = title.join(' ').replace(/\s+/g, (run) => (run.includes('\n') ? ' ' : run))
  const heading = title.length > 0 ? `## Slide ${index + 1}: ${titleText}` : `## Slide ${index + 1}`
  return [heading, ...body, ...(notes.length > 0 ? ['', 'Speaker notes:', ...notes] : [])].join('\n')
}

/**
 * Extracts a deck's text for the model: each slide in the order it is shown, with its title, its other text and its
 * speaker notes. Pictures, charts and diagrams carry no text here. Each part, and each piece of text in it, is read
 * once, however many times the deck lists or nests it, so the text is never longer than the XML it comes from.
 */
export const pptxToText = async (file: StoredFile): Promise<{ text: string }> => {
  const parts = unpackXmlParts(new Uint8Array(await file.blob.arrayBuffer()))
  const presentation = 'ppt/presentation.xml'
  const targets = new Map(relationships(parts, presentation).map(({ id, target }) => [id, target]))
  const ids = new Set(
    [...(parseXml(parts, presentation)?.getElementsByTagNameNS(ns.p, 'sldId') ?? [])].map((slide) =>
      slide.getAttributeNS(ns.r, 'id'),
    ),
  )
  const slides = new Set(
    [...ids]
      .map((id) => targets.get(id))
      .filter((target) => target !== undefined)
      .map((target) => resolvePart(presentation, target)),
  )
  if (slides.size === 0) {
    throw new Error('This presentation has no slides that could be read.')
  }
  const readNotes = new Set<string>()
  const text: string[] = []
  for (const path of slides) {
    const notesTarget = relationships(parts, path).find(({ type }) => type.endsWith('/notesSlide'))?.target
    const notes = notesTarget === undefined ? undefined : resolvePart(path, notesTarget)
    const unread = notes && !readNotes.has(notes) ? notes : undefined
    if (unread) {
      readNotes.add(unread)
    }
    text.push(slideText(parts, path, text.length, unread))
  }
  return { text: text.join('\n\n') }
}
