/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/*
 * Evaluated inside the output check's VM, never imported by the app; bundled into one script by
 * `?sandbox-script`. The VM evaluates `ooxml-globals.ts` first, so the zip and XML libraries are globals here and
 * are only typed, not bundled again. Each file comes in through `__savedFile`, and each XML part is inflated and
 * parsed on its own, so only one part and its DOM are alive at a time. The parser stops on warnings too: by default
 * it accepts an undefined entity and an unquoted attribute, which Office does not. A memory or stack error means the
 * check itself ran out of room, so it is rethrown to the host, which reports the file as too large to check. An
 * entry that understates its size inflates to no more than that size, but decoding the rest still takes time, which
 * the deadline bounds.
 */
import type * as Xmldom from '@xmldom/xmldom'
import type { Document, Element, Node } from '@xmldom/xmldom'
import type * as Fflate from 'fflate'

declare const fflate: typeof Fflate
declare const xmldom: typeof Xmldom
/** QuickJS's error for running out of memory or stack. */
declare const InternalError: ErrorConstructor
/** The host's copy of saved file `index`, or of input `index`. */
/* eslint-disable @typescript-eslint/naming-convention -- named like the host functions of the script VM */
declare const __savedFile: (index: number) => Uint8Array
declare const __inputFile: (index: number) => Uint8Array
/* eslint-enable @typescript-eslint/naming-convention */

/** What the host turns into the message the model reads; see `describeProblem` in `check-output.ts`. */
type Problem = {
  reason?: string
  part?: string
  badName?: string
  duplicate?: string
  tooLarge?: true
  unzipsTooLarge?: true
  macros?: boolean
  dde?: true
  added?: string
  detail?: string
  changed?: string
  addedMacros?: true
}

type Limits = { maxXmlBytes: number; maxUnzipBytes: number }

type OpenField = { code: string; done: boolean; ns: string | null; deleted: boolean }

/** A relationship to active content: an external one has a `key`, an internal one the parts its target names. */
type ActiveContent = { kind: string; part: string; key?: string; targets: string[] }

// Office may keep a part in UTF-16, which XML requires to start with a byte-order mark.
const utf16 = new Map([
  [0xfffe, 'utf-16le'],
  [0xfeff, 'utf-16be'],
])
const latin1 = (data: Uint8Array) => {
  const chunks = []
  for (let i = 0; i < data.length; i += 8192) {
    chunks.push(String.fromCharCode(...data.subarray(i, i + 8192)))
  }
  return chunks.join('')
}
const declaration = /^<\?xml[^>]*\sencoding\s*=\s*["']([^"']*)["']/
const decode = (data: Uint8Array) => {
  const encoding = utf16.get((data[0] << 8) | data[1]) ?? 'utf-8'
  // A legacy single-byte encoding such as windows-1252 writes markup in the same bytes as ASCII, so one character per
  // byte checks the XML as well as decoding it would. One that shifts state, such as UTF-7, spells other text.
  const head = declaration.exec(latin1(data.subarray(0, 256)))?.[1]
  if (encoding === 'utf-8' && head !== undefined && !/^utf-(8|16)$/i.test(head)) {
    if (!/^((us-)?ascii|iso-8859-\d+|windows-125\d)$/i.test(head)) {
      throw new Error(
        'the XML declaration says encoding="' +
          head +
          '", which this check cannot read; declare UTF-8 or leave the encoding out',
      )
    }
    return latin1(data)
  }
  const text = new TextDecoder(encoding, { fatal: true }).decode(data)
  // XML calls a declaration that names another encoding a fatal error, though this parser ignores it.
  const declared = declaration.exec(text)?.[1]
  const actual = encoding.slice(0, 6).toUpperCase()
  if (declared !== undefined && declared.toUpperCase() !== actual) {
    throw new Error(
      'the XML declaration says encoding="' +
        declared +
        '", but the part is ' +
        actual +
        '; declare ' +
        actual +
        ' or leave the encoding out',
    )
  }
  return text
}
const isXmlPart = (name: string) => /\.(xml|rels)$/i.test(name)
// A part name is a relative path inside the zip; another program could take one of these as a place on its disk.
const isBadName = (name: string) => /^$|^\/|\\|:|(^|\/)\.\.?(\/|$)|\/\//.test(name)
const isElement = (node: Node): node is Element => node.nodeType === 1
// Only the attribute in the element's own namespace, as Word reads w:fldCharType, not a decoy x:fldCharType beside it.
const attribute = (node: Element, name: string) =>
  Array.from(node.attributes).find((a) => a.localName === name && a.namespaceURI === node.namespaceURI)?.value
// Whether Word shows this field mark or code text as a tracked deletion.
const deleted = (node: Node): boolean =>
  node.localName === 'delInstrText' ||
  (node.parentNode !== null && (/^(del|moveFrom)$/.test(node.parentNode.localName ?? '') || deleted(node.parentNode)))
// Markup in a field code that Word may read differently from this check. That is any of these:
// - an element in another namespace than the begin mark (Word ignores one, or reads one branch of an
//   mc:AlternateContent);
// - a simple field, whose result may become code;
// - a mark or code text whose tracked deletion differs from the begin mark's.
const unreadable = (node: Node, field: OpenField) =>
  node.nodeType === 1 &&
  (node.namespaceURI !== field.ns ||
    node.localName === 'fldSimple' ||
    (/^(fldChar|instrText|delInstrText)$/.test(node.localName ?? '') && deleted(node) !== field.deleted))
// Each field's code on its own: each instr of a simple field, or the runs between a field's begin and separate
// marks, which may split it anywhere. A field nested in a code shows there inside braces, and markup Word may read
// otherwise as {}. Runs outside any field are joined into one more code.
const fieldCodes = (doc: Document) => {
  const codes = Array.from(doc.getElementsByTagNameNS('*', 'fldSimple')).flatMap((field) =>
    Array.from(field.attributes)
      .filter((a) => a.localName === 'instr')
      .map((a) => a.value),
  )
  const open: OpenField[] = []
  let stray = ''
  for (let node: Node | null = doc.documentElement; node !== null; ) {
    const field = open.at(-1)
    if (field !== undefined && !field.done && unreadable(node, field)) {
      field.code += '{}'
    }
    if (isElement(node) && node.localName === 'fldChar') {
      const type = attribute(node, 'fldCharType')
      // A mark with no type Word reads may begin, split or end a code where this check cannot tell.
      if (type === undefined) {
        codes.push('{}')
      }
      if (type === 'begin') {
        if (field !== undefined && !field.done) {
          field.code += '{'
        }
        open.push({ code: '', done: false, ns: node.namespaceURI, deleted: deleted(node) })
      }
      if (type === 'separate' && field !== undefined) {
        field.done = true
      }
      if (type === 'end' && field !== undefined) {
        open.pop()
        codes.push(field.code)
        const parent = open.at(-1)
        if (parent !== undefined && !parent.done) {
          parent.code += field.code + '}'
        }
      }
    } else if (node.localName === 'instrText' || node.localName === 'delInstrText') {
      if (field === undefined) {
        stray += node.textContent ?? ''
      } else if (!field.done) {
        field.code += node.textContent ?? ''
      }
    }
    // Run properties are formatting, which Word writes in other namespaces too, never a mark or code text it reads.
    if (node.firstChild !== null && node.localName !== 'rPr') {
      node = node.firstChild
      continue
    }
    while (node !== null && node.nextSibling === null) {
      node = node.parentNode
    }
    node = node === null ? null : node.nextSibling
  }
  return [...codes, ...open.map(({ code }) => code), stray]
}
// A DDE field runs a program when a document opens, as does a DDE link in a workbook. Its name counts though markup
// splits it or comes before it.
const hasDde = (doc: Document) =>
  doc.getElementsByTagNameNS('*', 'ddeLink').length > 0 ||
  fieldCodes(doc).some(
    (code) => /^\s*DDE(AUTO)?\b/i.test(code.replaceAll('{}', '')) || /\{\}[\s\S]*\bDDE(AUTO)?\b/i.test(code),
  )
// A Word field that fills itself from another file, a database or a web address when it updates, with no
// relationship to check. A field also counts when a nested field or markup decides its name, as in
// { {QUOTE 68 68 69} ... }, which spells DDE when Word runs it: it has a { before the first space.
// A formula field, { ={PAGE}+1 }, only computes, so it does not count.
// Compared as written: spacing inside a quoted path names another file.
const inclusions = (doc: Document) =>
  fieldCodes(doc).filter((code) =>
    /^\s*((INCLUDEPICTURE|INCLUDETEXT|INCLUDE|IMPORT|LINK|DATABASE|RD)\b|(?!=)[^\s{]*\{)/i.test(code),
  )
// An action PowerPoint runs without a click, a mouse-over action or an OLE verb command in a slide's timing, or a
// Power Query, which Excel runs when its data connection refreshes.
const autoRun = (doc: Document, text: string) => {
  if (doc.documentElement?.localName === 'DataMashup') {
    return 'query'
  }
  // An element's name cannot be escaped, so a part whose text lacks these names has none of these elements.
  if (!/hlinkHover|hlinkMouseOver|cmd/.test(text)) {
    return undefined
  }
  const hover = ['hlinkHover', 'hlinkMouseOver'].some((name) => doc.getElementsByTagNameNS('*', name).length > 0)
  const verb = Array.from(doc.getElementsByTagNameNS('*', 'cmd')).some(
    (node) => node.getAttribute('type')?.trim() === 'verb',
  )
  return hover || verb ? 'autoAction' : undefined
}
type ContentType = string | null | undefined
// Code that Office runs: a VBA project or an Excel 4.0 macro sheet, known by the content type the package gives it.
const isMacroType = (type: ContentType) =>
  /^application\/vnd\.ms-(office\.vbaproject|excel\.(intl)?macrosheet\+xml)$/i.test(type ?? '')
// Only application/ and text/ types: an image/svg+xml picture holds no fields, and a strict parse refuses valid ones.
const isXmlType = (type: ContentType) => /^(application|text)\/([^/;]*\+)?xml\s*(;.*)?$/i.test(type ?? '')
// OPC compares part names without case, so Office finds the content types under any capitalization.
const isContentTypes = (name: string) => /^\[content_types\]\.xml$/i.test(name)
// Each part's content type as Office resolves it: an Override by part name, else a Default by extension.
const contentTypes = (types: Document) => {
  const typeOf = new Map<string, string | null>()
  for (const node of Array.from(types.getElementsByTagNameNS('*', 'Default'))) {
    typeOf.set('.' + (node.getAttribute('Extension') ?? '').toLowerCase(), node.getAttribute('ContentType'))
  }
  for (const node of Array.from(types.getElementsByTagNameNS('*', 'Override'))) {
    typeOf.set((node.getAttribute('PartName') ?? '').toLowerCase(), node.getAttribute('ContentType'))
  }
  return (name: string): ContentType => {
    const lower = name.toLowerCase()
    return typeOf.get('/' + lower) ?? typeOf.get(lower.slice(lower.lastIndexOf('.')))
  }
}
const macroPartNames = (types: Document, names: string[]) => {
  const typeOf = contentTypes(types)
  return names.filter((name) => isMacroType(typeOf(name)))
}
const macroParts = (bytes: Uint8Array, types: Document, names: string[]) => {
  const wanted = macroPartNames(types, names)
  return wanted.length === 0
    ? []
    : Object.entries(fflate.unzipSync(bytes, { filter: ({ name }) => wanted.includes(name) }))
}
const sameBytes = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((byte, index) => byte === b[index])
/** The message of a value a check step threw, or the value rethrown when the check itself ran out of room. */
const reason = (cause: unknown) => {
  const text = cause instanceof Error ? cause.message : String(cause)
  // The parser wraps what is thrown while it parses, so a memory error can arrive inside a parse error.
  if (cause instanceof InternalError || /out of memory|stack overflow/i.test(text)) {
    throw cause
  }
  return text.replace(/\s+/g, ' ').trim()
}
const read = (bytes: Uint8Array, name: string) =>
  fflate.unzipSync(bytes, { filter: (file) => file.name === name })[name]
const readXml = (bytes: Uint8Array, name: string) =>
  new xmldom.DOMParser({ onError: () => {} }).parseFromString(decode(read(bytes, name)), 'text/xml')
const isExternal = (relationship: Element) => /^external$/i.test(relationship.getAttribute('TargetMode') ?? '')
// Parts inside the file that Office runs, or acts on when it opens or refreshes, by the type of relationship.
const internalKinds: [RegExp, string][] = [
  [/\/(vbaProject|wordVbaData|xlMacrosheet|xlIntlMacrosheet)$/i, 'macros'],
  [/\/oleObject$/i, 'ole'],
  [/\/aFChunk$/i, 'chunk'],
  [/\/(control|activeXControlBinary)$/i, 'activeX'],
  [/\/connections$/i, 'connection'],
  [/\/package$/i, 'package'],
]
// Content that Office fetches from outside the file, or runs. A hyperlink opens on a click, so it does not count; a
// mouse-over action, which needs none, is found in the part that holds it.
const activeKind = (relationship: Element) => {
  const type = (relationship.getAttribute('Type') ?? '').trim()
  if (!isExternal(relationship)) {
    return internalKinds.find(([pattern]) => pattern.test(type))?.[1]
  }
  if (/\/hyperlink$/i.test(type)) {
    return undefined
  }
  if (/\/attachedTemplate$/i.test(type)) {
    return 'template'
  }
  return /\/oleObject$/i.test(type) ? 'ole' : 'link'
}
const uriDecoded = (text: string) => {
  try {
    return decodeURIComponent(text)
  } catch {
    return text
  }
}
// The parts an internal target names, matched without case as OPC compares part names, as written or with its
// percent-encoding decoded. A target starting with / is from the package root, any other from the folder of the
// part the relationships are for.
const targetParts = (relationships: string, target: string, names: string[]) => {
  const path = target.startsWith('/')
    ? []
    : relationships
        .replace(/_rels\/[^/]*$/i, '')
        .split('/')
        .slice(0, -1)
  for (const segment of target.split('/')) {
    if (segment === '..') {
      path.pop()
    } else if (segment !== '.' && segment !== '') {
      path.push(segment)
    }
  }
  const wanted = path.join('/').toLowerCase()
  return names.filter((name) => name.toLowerCase() === wanted || name.toLowerCase() === uriDecoded(wanted))
}
const partNames = (bytes: Uint8Array) => {
  const names: string[] = []
  fflate.unzipSync(bytes, {
    filter: ({ name }) => {
      names.push(name)
      return false
    },
  })
  return names
}
// Each relationship to active content, read from every relationships part: an external one keyed by its type and
// target, an internal one with the parts its target names.
const activeContent = (bytes: Uint8Array, names: string[]): ActiveContent[] =>
  names
    .filter((name) => /\.rels$/i.test(name))
    .flatMap((part) => {
      // Office cannot read this part either, so it points nowhere.
      try {
        return Array.from(readXml(bytes, part).getElementsByTagNameNS('*', 'Relationship')).flatMap((relationship) => {
          const kind = activeKind(relationship)
          const target = relationship.getAttribute('Target') ?? ''
          if (kind === undefined) {
            return []
          }
          return isExternal(relationship)
            ? [{ kind, part, key: (relationship.getAttribute('Type') ?? '') + ' ' + target, targets: [] }]
            : [{ kind, part, targets: targetParts(part, target, names) }]
        })
      } catch (error) {
        reason(error)
        return []
      }
    })
let inputContent: Set<string> | undefined
// The external active content of the inputs, read once per check; a damaged input has none.
const inputKeys = (count: number) =>
  (inputContent ??= new Set(
    Array.from({ length: count }, (_, index) => {
      try {
        const bytes = __inputFile(index)
        return activeContent(bytes, partNames(bytes)).flatMap(({ key }) => key ?? [])
      } catch (error) {
        reason(error)
        return []
      }
    }).flat(),
  ))
type InputPart = { index: number; name: string; size: number | undefined; kinds: string[] }
let inputParts: InputPart[] | undefined
// Each input part with the kinds of content it holds in its input: the kind of each relationship to it, `macros`
// for a macro content type, and `xml` for an XML part, which this check parses. A saved part counts only as a kind
// an input part with the same bytes had. An earlier output already passed this check, so a part it hid elsewhere,
// or under another kind, does not count. The list is built once per check from the central directory, inflating
// only the relationships and content types. A damaged input has none.
const keptParts = (count: number) =>
  (inputParts ??= Array.from({ length: count }, (_, index): InputPart[] => {
    try {
      const bytes = __inputFile(index)
      const sizes = new Map<string, number>()
      fflate.unzipSync(bytes, {
        filter: ({ name, originalSize }) => {
          sizes.set(name, originalSize)
          return false
        },
      })
      const names = [...sizes.keys()]
      const types = names.find(isContentTypes)
      const typeOf = types === undefined ? () => undefined : contentTypes(readXml(bytes, types))
      const kinds = new Map(names.map((name) => [name, isXmlPart(name) || isXmlType(typeOf(name)) ? ['xml'] : []]))
      names.filter((name) => isMacroType(typeOf(name))).forEach((name) => kinds.get(name)?.push('macros'))
      for (const { kind, targets } of activeContent(bytes, names)) {
        targets.forEach((target) => kinds.get(target)?.push(kind))
      }
      return names.map((name) => ({ index, name, size: sizes.get(name), kinds: kinds.get(name) ?? [] }))
    } catch (error) {
      reason(error)
      return []
    }
  }).flat())
// Whether an input has a part of this kind with these bytes; only parts of the same size are inflated.
const keptPart = (count: number, data: Uint8Array, kind: string) =>
  keptParts(count).some(
    (part) =>
      part.kinds.includes(kind) &&
      part.size === data.length &&
      sameBytes(read(__inputFile(part.index), part.name), data),
  )
let inputInclusions: Set<string> | undefined
// The inclusion fields the inputs hold, read once per check and only for a saved file that has one.
const keptInclusions = (count: number) =>
  (inputInclusions ??= new Set(
    Array.from({ length: count }, (_, index) => {
      try {
        const bytes = __inputFile(index)
        const names = partNames(bytes)
        // The parts the saved file's check reads: XML by name, or by the content type the package gives it.
        const types = names.find(isContentTypes)
        const typeOf = types === undefined ? () => undefined : contentTypes(readXml(bytes, types))
        return names
          .filter((name) => isXmlPart(name) || isXmlType(typeOf(name)))
          .flatMap((name) => inclusions(readXml(bytes, name)))
      } catch (error) {
        reason(error)
        return []
      }
    }).flat(),
  ))
// What a relationship to active content adds: an external one no input had with the same type and target, or an
// internal one whose part no input had with the same bytes. An embedded package no input had is checked like the
// file. A target this check cannot find is refused, because Office might resolve a name the check cannot.
const addedBy = (
  bytes: Uint8Array,
  { kind, part, key, targets }: ActiveContent,
  inputs: number,
  limits: Limits,
): Problem | undefined => {
  if (key !== undefined) {
    return inputKeys(inputs).has(key) ? undefined : { added: kind, part }
  }
  if (targets.length === 0) {
    return kind === 'macros' ? { addedMacros: true, part } : { added: kind, part }
  }
  for (const target of targets) {
    const data = read(bytes, target)
    if (keptPart(inputs, data, kind)) {
      continue
    }
    if (kind === 'macros') {
      return { addedMacros: true, part: target }
    }
    if (kind !== 'package') {
      return { added: kind, part: target }
    }
    // The formula scan after this check reads a package only as a zip that starts at its first byte.
    if (!(data[0] === 0x50 && data[1] === 0x4b && data[2] === 3 && data[3] === 4)) {
      return { added: 'package', part: target }
    }
    const problem = checkPackage(data, null, null, inputs, limits)
    if (problem?.reason !== undefined && problem.part === undefined) {
      return { added: 'package', part: target }
    }
    if (problem !== undefined) {
      return { ...problem, part: problem.part === undefined ? target : target + ': ' + problem.part }
    }
  }
  return undefined
}
// `macros` is true for a .xlsm name, false for .xlsx and null for anything else; Excel opens a workbook only when
// its content type agrees. `only` lists the XML parts to parse, besides the content types; null parses them all.
// `inputs` is how many files the run read: active content none of them had is the script's own.
const checkPackage = (
  bytes: Uint8Array,
  macros: boolean | null,
  only: string[] | null,
  inputs: number,
  limits: Limits,
): Problem | undefined => {
  const all: string[] = []
  const names: string[] = []
  const sizes = new Map<string, number>()
  let declared = 0
  let total = 0
  let badName: string | undefined
  let duplicate: string | undefined
  const seen = new Set<string>()
  let types: Document | undefined
  const included: { code: string; part: string }[] = []
  // Excelize rewrites an external link it read, so its parts are parsed for a DDE link however the file was made.
  const parsed = (name: string) =>
    only === null || only.includes(name) || isContentTypes(name) || /^xl\/externalLinks\//.test(name)
  try {
    fflate.unzipSync(bytes, {
      filter: ({ name, originalSize }) => {
        all.push(name)
        sizes.set(name, originalSize)
        badName ??= isBadName(name) ? name : undefined
        // OPC forbids two parts whose names differ only in case: Office may read either, and this check the last.
        duplicate ??= seen.has(name.toLowerCase()) ? name : undefined
        seen.add(name.toLowerCase())
        total += originalSize
        if (isXmlPart(name) && parsed(name)) {
          // The content types come first: they name the other parts that are XML whatever their name.
          if (isContentTypes(name)) {
            names.unshift(name)
          } else {
            names.push(name)
          }
          declared += originalSize
        }
        return false
      },
    })
  } catch (error) {
    return { reason: reason(error) }
  }
  if (badName !== undefined) {
    return { badName }
  }
  if (duplicate !== undefined) {
    return { duplicate }
  }
  if (declared > limits.maxXmlBytes) {
    return { tooLarge: true }
  }
  if (total > limits.maxUnzipBytes) {
    return { unzipsTooLarge: true }
  }
  for (const name of names) {
    let data: Uint8Array
    try {
      data = read(bytes, name)
    } catch (error) {
      return { reason: reason(error) }
    }
    let text: string
    let doc: Document
    try {
      text = decode(data)
      doc = new xmldom.DOMParser({ onError: xmldom.onWarningStopParsing }).parseFromString(text, 'text/xml')
    } catch (error) {
      return { part: name, reason: reason(error) }
    }
    if (hasDde(doc)) {
      return { part: name, dde: true }
    }
    // Excelize never writes these, so the parts it wrote lose nothing by being skipped. An action's target is in the
    // part's relationships, so they are kept too.
    const action = autoRun(doc, text)
    if (action !== undefined) {
      const slash = name.lastIndexOf('/') + 1
      const relationships = (name.slice(0, slash) + '_rels/' + name.slice(slash) + '.rels').toLowerCase()
      const own = all.filter((part) => part.toLowerCase() === relationships).map((part) => read(bytes, part))
      if ([data, ...own].some((part) => !keptPart(inputs, part, 'xml'))) {
        return { changed: action, part: name }
      }
    }
    included.push(...inclusions(doc).map((code) => ({ code, part: name })))
    if (isContentTypes(name)) {
      if (macros !== null && text.includes('macroEnabled.main+xml') !== macros) {
        return { macros }
      }
      types = doc
      // Office reads a part as XML when its content type says so, so a script cannot hide one under another name.
      const typeOf = contentTypes(doc)
      const typedXml = all.filter((part) => !isXmlPart(part) && parsed(part) && isXmlType(typeOf(part)))
      declared = typedXml.reduce((sum, part) => sum + (sizes.get(part) ?? 0), declared)
      if (declared > limits.maxXmlBytes) {
        return { tooLarge: true }
      }
      names.push(...typedXml)
    }
  }
  for (const relationship of activeContent(bytes, all)) {
    const added = addedBy(bytes, relationship, inputs, limits)
    if (added !== undefined) {
      return added
    }
  }
  // An edit may keep a field the user's file had, unchanged, but never add one or point one elsewhere.
  const field = included.find(({ code }) => !keptInclusions(inputs).has(code))
  if (field !== undefined) {
    return { added: 'field', part: field.part, detail: field.code }
  }
  // A script may keep the macros of a file it read, byte for byte, but never add or change any.
  const macro = types && macroParts(bytes, types, all).find(([, data]) => !keptPart(inputs, data, 'macros'))
  if (macro) {
    return { addedMacros: true, part: macro[0] }
  }
  return undefined
}

/** Checks saved file `index`; see `findBrokenFile` in `check-output.ts` for the arguments. */
const check = (
  index: number,
  macros: boolean | null,
  only: string[] | null,
  inputs: number,
  maxXmlBytes: number,
  maxUnzipBytes: number,
) => checkPackage(__savedFile(index), macros, only, inputs, { maxXmlBytes, maxUnzipBytes })

Object.assign(globalThis, { __check: check })
