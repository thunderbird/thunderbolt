/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { partChecksums, unzipWithinLimits, ZipLimitError } from '@/files/unzip-within-limits'
import { promptFileName, safeFileName } from '@/lib/safe-file-name'
import { type JSValueHandle, QuickJS } from 'quickjs-wasi'
import type { SandboxLimits } from './constants'
import { decodeXml, externalDataFormulas } from './formula-cache'
import type { SandboxInput, SandboxRuntime, SavedFile } from './sandbox'

// A DOM in QuickJS takes several times the memory of its XML; a 1,000-page document.xml is about 3.5 MB.
const checkMemoryFactor = 4

/*
 * Runs in the check VM, which holds only the zip and XML libraries. Each file comes in through `__savedFile`, and
 * each XML part is inflated and parsed on its own, so only one part and its DOM are alive at a time. The parser
 * stops on warnings too: by default it accepts an undefined entity and an unquoted attribute, which Office does not.
 * A memory or stack error means the check itself ran out of room, so it is rethrown to the host, which reports the
 * file as too large to check. An entry that understates its size inflates to no more than that size, but decoding
 * the rest still takes time, which the deadline bounds.
 */
const checker = (maxXmlBytes: number, maxUnzipBytes: number) => `(() => {
  // Office may keep a part in UTF-16, which XML requires to start with a byte-order mark.
  const utf16 = { 0xfffe: 'utf-16le', 0xfeff: 'utf-16be' }
  const latin1 = (data) => {
    const chunks = []
    for (let i = 0; i < data.length; i += 8192) chunks.push(String.fromCharCode.apply(null, data.subarray(i, i + 8192)))
    return chunks.join('')
  }
  const declaration = /^<\\?xml[^>]*\\sencoding\\s*=\\s*["']([^"']*)["']/
  const decode = (data) => {
    const encoding = utf16[(data[0] << 8) | data[1]] ?? 'utf-8'
    // A legacy single-byte encoding such as windows-1252 writes markup in the same bytes as ASCII, so one character per
    // byte checks the XML as well as decoding it would. One that shifts state, such as UTF-7, spells other text.
    const head = declaration.exec(latin1(data.subarray(0, 256)))?.[1]
    if (encoding === 'utf-8' && head !== undefined && !/^utf-(8|16)$/i.test(head)) {
      if (!/^((us-)?ascii|iso-8859-\\d+|windows-125\\d)$/i.test(head)) {
        throw new Error('the XML declaration says encoding="' + head + '", which this check cannot read; declare UTF-8 or leave the encoding out')
      }
      return latin1(data)
    }
    const text = new TextDecoder(encoding, { fatal: true }).decode(data)
    // XML calls a declaration that names another encoding a fatal error, though this parser ignores it.
    const declared = declaration.exec(text)?.[1]
    const actual = encoding.slice(0, 6).toUpperCase()
    if (declared !== undefined && declared.toUpperCase() !== actual) {
      throw new Error('the XML declaration says encoding="' + declared + '", but the part is ' + actual + '; declare ' + actual + ' or leave the encoding out')
    }
    return text
  }
  const isXmlPart = (name) => /\\.(xml|rels)$/i.test(name)
  // A part name is a relative path inside the zip; another program could take one of these as a place on its disk.
  const isBadName = (name) => /^$|^\\/|\\\\|:|(^|\\/)\\.\\.?(\\/|$)|\\/\\//.test(name)
  // Only the attribute in the element's own namespace, as Word reads w:fldCharType, not a decoy x:fldCharType beside it.
  const attribute = (node, name) =>
    Array.from(node.attributes).find((a) => a.localName === name && a.namespaceURI === node.namespaceURI)?.value
  // Whether Word shows this field mark or code text as a tracked deletion.
  const deleted = (node) =>
    node.localName === 'delInstrText' ||
    (node.parentNode !== null && (/^(del|moveFrom)$/.test(node.parentNode.localName) || deleted(node.parentNode)))
  // Markup in a field code that Word may read otherwise than this check: an element in another namespace than the
  // begin mark (one Word ignores, or mc:AlternateContent, of whose branches Word reads one), a simple field, whose
  // result may become code, or a mark or code text whose tracked deletion differs from the begin mark's.
  const unreadable = (node, field) =>
    node.nodeType === 1 &&
    (node.namespaceURI !== field.ns ||
      node.localName === 'fldSimple' ||
      (/^(fldChar|instrText|delInstrText)$/.test(node.localName) && deleted(node) !== field.deleted))
  // Each field's code on its own: each instr of a simple field, or the runs between a field's begin and separate
  // marks, which may split it anywhere. A field nested in a code shows there inside braces, and markup Word may read
  // otherwise as {}. Runs outside any field are joined into one more code.
  const fieldCodes = (doc) => {
    const codes = Array.from(doc.getElementsByTagNameNS('*', 'fldSimple')).flatMap((field) =>
      Array.from(field.attributes)
        .filter((a) => a.localName === 'instr')
        .map((a) => a.value),
    )
    const open = []
    let stray = ''
    for (let node = doc.documentElement; node !== null; ) {
      const field = open[open.length - 1]
      if (field !== undefined && !field.done && unreadable(node, field)) field.code += '{}'
      if (node.localName === 'fldChar') {
        const type = attribute(node, 'fldCharType')
        // A mark with no type Word reads may begin, split or end a code where this check cannot tell.
        if (type === undefined) codes.push('{}')
        if (type === 'begin') {
          if (field !== undefined && !field.done) field.code += '{'
          open.push({ code: '', done: false, ns: node.namespaceURI, deleted: deleted(node) })
        }
        if (type === 'separate' && field !== undefined) field.done = true
        if (type === 'end' && field !== undefined) {
          const { code } = open.pop()
          codes.push(code)
          const parent = open[open.length - 1]
          if (parent !== undefined && !parent.done) parent.code += code + '}'
        }
      } else if (node.localName === 'instrText' || node.localName === 'delInstrText') {
        if (field === undefined) stray += node.textContent
        else if (!field.done) field.code += node.textContent
      }
      // Run properties are formatting, which Word writes in other namespaces too, never a mark or code text it reads.
      if (node.firstChild !== null && node.localName !== 'rPr') {
        node = node.firstChild
        continue
      }
      while (node !== null && node.nextSibling === null) node = node.parentNode
      node = node === null ? null : node.nextSibling
    }
    return [...codes, ...open.map(({ code }) => code), stray]
  }
  // A DDE field runs a program when a document opens, as does a DDE link in a workbook. Its name counts though markup
  // splits it or comes before it.
  const hasDde = (doc) =>
    doc.getElementsByTagNameNS('*', 'ddeLink').length > 0 ||
    fieldCodes(doc).some(
      (code) => /^\\s*DDE(AUTO)?\\b/i.test(code.replaceAll('{}', '')) || /\\{\\}[\\s\\S]*\\bDDE(AUTO)?\\b/i.test(code),
    )
  // A Word field that fills itself from another file, a database or a web address when it updates, with no
  // relationship to check. So is one whose name a nested field or markup decides, as in { {QUOTE 68 68 69} ... },
  // which spells DDE when Word runs it: a { before the first space. A formula field, { ={PAGE}+1 }, only computes.
  const inclusions = (doc) =>
    fieldCodes(doc)
      .filter((code) =>
        /^\\s*((INCLUDEPICTURE|INCLUDETEXT|INCLUDE|IMPORT|LINK|DATABASE|RD)\\b|(?!=)[^\\s{]*\\{)/i.test(code),
      )
      .map((code) => code.replace(/\\s+/g, ' ').trim())
  // An action PowerPoint runs without a click, a mouse-over action or an OLE verb command in a slide's timing, or a
  // Power Query, which Excel runs when its data connection refreshes.
  const autoRun = (doc, text) => {
    if (doc.documentElement.localName === 'DataMashup') return 'query'
    // An element's name cannot be escaped, so a part whose text lacks these names has none of these elements.
    if (!/hlinkHover|hlinkMouseOver|cmd/.test(text)) return undefined
    const hover = ['hlinkHover', 'hlinkMouseOver'].some((name) => doc.getElementsByTagNameNS('*', name).length > 0)
    const verb = Array.from(doc.getElementsByTagNameNS('*', 'cmd')).some((node) => node.getAttribute('type')?.trim() === 'verb')
    return hover || verb ? 'autoAction' : undefined
  }
  // Code that Office runs: a VBA project or an Excel 4.0 macro sheet, known by the content type the package gives it.
  const isMacroType = (type) => /^application\\/vnd\\.ms-(office\\.vbaproject|excel\\.(intl)?macrosheet\\+xml)$/i.test(type ?? '')
  // Only application/ and text/ types: an image/svg+xml picture holds no fields, and a strict parse refuses valid ones.
  const isXmlType = (type) => /^(application|text)\\/([^\\/;]*\\+)?xml\\s*(;.*)?$/i.test(type ?? '')
  // OPC compares part names without case, so Office finds the content types under any capitalization.
  const isContentTypes = (name) => /^\\[content_types\\]\\.xml$/i.test(name)
  // Each part's content type as Office resolves it: an Override by part name, else a Default by extension.
  const contentTypes = (types) => {
    const typeOf = new Map()
    for (const node of Array.from(types.getElementsByTagNameNS('*', 'Default'))) {
      typeOf.set('.' + (node.getAttribute('Extension') ?? '').toLowerCase(), node.getAttribute('ContentType'))
    }
    for (const node of Array.from(types.getElementsByTagNameNS('*', 'Override'))) {
      typeOf.set((node.getAttribute('PartName') ?? '').toLowerCase(), node.getAttribute('ContentType'))
    }
    return (name) => {
      const lower = name.toLowerCase()
      return typeOf.get('/' + lower) ?? typeOf.get(lower.slice(lower.lastIndexOf('.')))
    }
  }
  const macroPartNames = (types, names) => {
    const typeOf = contentTypes(types)
    return names.filter((name) => isMacroType(typeOf(name)))
  }
  const macroParts = (bytes, types, names) => {
    const wanted = macroPartNames(types, names)
    return wanted.length === 0 ? [] : Object.entries(fflate.unzipSync(bytes, { filter: ({ name }) => wanted.includes(name) }))
  }
  const sameBytes = (a, b) => a.length === b.length && a.every((byte, index) => byte === b[index])
  const reason = (error) => {
    const text = error instanceof Error ? error.message : String(error)
    // The parser wraps what is thrown while it parses, so a memory error can arrive inside a parse error.
    if (error instanceof InternalError || /out of memory|stack overflow/i.test(text)) throw error
    return text.replace(/\\s+/g, ' ').trim()
  }
  const read = (bytes, name) => fflate.unzipSync(bytes, { filter: (file) => file.name === name })[name]
  const readXml = (bytes, name) =>
    new xmldom.DOMParser({ onError: () => {} }).parseFromString(decode(read(bytes, name)), 'text/xml')
  const isExternal = (relationship) => /^external$/i.test(relationship.getAttribute('TargetMode') ?? '')
  // Parts inside the file that Office runs, or acts on when it opens or refreshes, by the type of relationship.
  const internalKinds = [
    [/\\/(vbaProject|wordVbaData|xlMacrosheet|xlIntlMacrosheet)$/i, 'macros'],
    [/\\/oleObject$/i, 'ole'],
    [/\\/aFChunk$/i, 'chunk'],
    [/\\/(control|activeXControlBinary)$/i, 'activeX'],
    [/\\/connections$/i, 'connection'],
    [/\\/package$/i, 'package'],
  ]
  // Content that Office fetches from outside the file, or runs. A hyperlink opens on a click, so it does not count; a
  // mouse-over action, which needs none, is found in the part that holds it.
  const activeKind = (relationship) => {
    const type = (relationship.getAttribute('Type') ?? '').trim()
    if (!isExternal(relationship)) return internalKinds.find(([pattern]) => pattern.test(type))?.[1]
    if (/\\/hyperlink$/i.test(type)) return undefined
    if (/\\/attachedTemplate$/i.test(type)) return 'template'
    return /\\/oleObject$/i.test(type) ? 'ole' : 'link'
  }
  const uriDecoded = (text) => {
    try {
      return decodeURIComponent(text)
    } catch {
      return text
    }
  }
  // The parts an internal target names, matched without case as OPC compares part names, as written or with its
  // percent-encoding decoded. A target starting with / is from the package root, any other from the folder of the
  // part the relationships are for.
  const targetParts = (relationships, target, names) => {
    const path = target.startsWith('/') ? [] : relationships.replace(/_rels\\/[^\\/]*$/i, '').split('/').slice(0, -1)
    for (const segment of target.split('/')) {
      if (segment === '..') path.pop()
      else if (segment !== '.' && segment !== '') path.push(segment)
    }
    const wanted = path.join('/').toLowerCase()
    return names.filter((name) => name.toLowerCase() === wanted || name.toLowerCase() === uriDecoded(wanted))
  }
  const partNames = (bytes) => {
    const names = []
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
  const activeContent = (bytes, names) =>
    names
      .filter((name) => /\\.rels$/i.test(name))
      .flatMap((part) => {
        // Office cannot read this part either, so it points nowhere.
        try {
          return Array.from(readXml(bytes, part).getElementsByTagNameNS('*', 'Relationship')).flatMap((relationship) => {
            const kind = activeKind(relationship)
            const target = relationship.getAttribute('Target') ?? ''
            if (kind === undefined) return []
            return isExternal(relationship)
              ? [{ kind, part, key: (relationship.getAttribute('Type') ?? '') + ' ' + target }]
              : [{ kind, part, targets: targetParts(part, target, names) }]
          })
        } catch (error) {
          reason(error)
          return []
        }
      })
  let inputContent
  // The external active content of the inputs, read once per check; a damaged input has none.
  const inputKeys = (count) =>
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
  let inputParts
  // Each input part with the kinds of content it holds in its input: the kind of each relationship to it, macros
  // for a macro content type, and xml for an XML part, which this check parses. A saved part is kept only as a kind
  // an input part of the same bytes had: an earlier output passed this check, so a part it hid elsewhere, or under
  // another kind, does not count. Listed once per check from the central directory, inflating only the
  // relationships and content types; a damaged input has none.
  const keptParts = (count) =>
    (inputParts ??= Array.from({ length: count }, (_, index) => {
      try {
        const bytes = __inputFile(index)
        const sizes = new Map()
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
        names.filter((name) => isMacroType(typeOf(name))).forEach((name) => kinds.get(name).push('macros'))
        for (const { kind, targets = [] } of activeContent(bytes, names)) {
          targets.forEach((target) => kinds.get(target).push(kind))
        }
        return names.map((name) => ({ index, name, size: sizes.get(name), kinds: kinds.get(name) }))
      } catch (error) {
        reason(error)
        return []
      }
    }).flat())
  // Whether an input has a part of this kind with these bytes; only parts of the same size are inflated.
  const keptPart = (count, data, kind) =>
    keptParts(count).some(
      (part) =>
        part.kinds.includes(kind) && part.size === data.length && sameBytes(read(__inputFile(part.index), part.name), data),
    )
  let inputInclusions
  // The inclusion fields the inputs hold, read once per check and only for a saved file that has one.
  const keptInclusions = (count) =>
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
  const addedBy = (bytes, { kind, part, key, targets }, inputs) => {
    if (key !== undefined) return inputKeys(inputs).has(key) ? undefined : { added: kind, part }
    if (targets.length === 0) return kind === 'macros' ? { addedMacros: true, part } : { added: kind, part }
    for (const target of targets) {
      const data = read(bytes, target)
      if (keptPart(inputs, data, kind)) continue
      if (kind === 'macros') return { addedMacros: true, part: target }
      if (kind !== 'package') return { added: kind, part: target }
      // The formula scan after this check reads a package only as a zip that starts at its first byte.
      if (!(data[0] === 0x50 && data[1] === 0x4b && data[2] === 3 && data[3] === 4)) return { added: 'package', part: target }
      const problem = checkPackage(data, null, null, inputs)
      if (problem?.reason !== undefined && problem.part === undefined) return { added: 'package', part: target }
      if (problem !== undefined) return { ...problem, part: problem.part === undefined ? target : target + ': ' + problem.part }
    }
  }
  // \`macros\` is true for a .xlsm name, false for .xlsx and null for anything else; Excel opens a workbook only when
  // its content type agrees. \`only\` lists the XML parts to parse, besides the content types; null parses them all.
  // \`inputs\` is how many files the run read: active content none of them had is the script's own.
  const checkPackage = (bytes, macros, only, inputs) => {
    const all = []
    const names = []
    const sizes = new Map()
    let declared = 0
    let total = 0
    let badName
    let duplicate
    const seen = new Set()
    let types
    const included = []
    // Excelize rewrites an external link it read, so its parts are parsed for a DDE link however the file was made.
    const parsed = (name) =>
      only === null || only.includes(name) || isContentTypes(name) || /^xl\\/externalLinks\\//.test(name)
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
            if (isContentTypes(name)) names.unshift(name)
            else names.push(name)
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
    if (declared > ${maxXmlBytes}) {
      return { tooLarge: true }
    }
    if (total > ${maxUnzipBytes}) {
      return { unzipsTooLarge: true }
    }
    for (const name of names) {
      let data
      try {
        data = read(bytes, name)
      } catch (error) {
        return { reason: reason(error) }
      }
      let text
      let doc
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
        declared = typedXml.reduce((sum, part) => sum + sizes.get(part), declared)
        if (declared > ${maxXmlBytes}) {
          return { tooLarge: true }
        }
        names.push(...typedXml)
      }
    }
    for (const relationship of activeContent(bytes, all)) {
      const added = addedBy(bytes, relationship, inputs)
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
  }
  globalThis.__check = (index, macros, only, inputs) => checkPackage(__savedFile(index), macros, only, inputs)
})()`

const tooLargeToCheck = (filename: string) =>
  `The XML in ${promptFileName(filename)} is too large to check. Make the file smaller or split it into several files, then call the tool again.`

/** Active content a script may not add, described as the model is told it. */
const addedContent = new Map([
  ['template', 'a template linked from outside the file, which Word downloads when the file opens'],
  ['link', 'a link to content outside the file, which Office can fetch when the file opens'],
  ['ole', 'an OLE object, which can run a program when it is opened'],
  [
    'field',
    'a field that loads content from outside the file, or whose name another field, a tracked change or markup Word skips decides, which Word acts on when the file opens',
  ],
  [
    'chunk',
    'an imported chunk (w:altChunk) of RTF, HTML or another document, which Word merges in when the file opens and this tool cannot check',
  ],
  ['activeX', 'an ActiveX control, which Office can load and run when the file opens'],
  ['connection', 'a data connection, which Excel can refresh from outside the file'],
  ['package', 'an embedded Office document this tool could not find or open to check'],
  [
    'formula',
    'a formula that fetches data from outside the file (WEBSERVICE, IMAGE, RTD or an IMPORT function), which Excel or Google Sheets runs when the workbook calculates',
  ],
])

/** `detail`, the field code or formula refused, lets the model tell its own addition from the user's content it moved. */
const addedProblem = (filename: string, added: string, part: string | undefined, detail?: string) => {
  const quoted = detail === undefined ? '' : ` (${JSON.stringify(detail.replace(/\s+/g, ' ').trim().slice(0, 80))})`
  return `${promptFileName(filename)} was not saved: the script added ${addedContent.get(added)}, in ${part}${quoted}, and no file it read had the same one unchanged. This tool does not add such content to a file. Explain to the user what was refused and why.`
}

/** Parts saved only as a file the script read had them, with their relationships, described as the model is told it. */
const keptOnly = new Map([
  [
    'autoAction',
    'holds a mouse-over action or an OLE verb command, which PowerPoint runs during a slide show without a click',
  ],
  ['query', 'is a Power Query (DataMashup) part, which Excel runs when its data connection refreshes'],
])

const changedProblem = (filename: string, changed: string, part: string | undefined) =>
  `${promptFileName(filename)} was not saved: ${part} ${keptOnly.get(changed)}, and no file the script read had that part and its relationships byte for byte. Leave both exactly as they were, without parsing and serializing them again, or explain to the user what was refused and why.`

const unzipsTooLarge = (filename: string, limits: SandboxLimits) =>
  `${promptFileName(filename)} unzips to more than ${limits.unzipBytes / 1024 / 1024} MiB, the most a saved file may hold. Make it smaller, for example with smaller images, then call the tool again.`

const notAZip = (filename: string, reason: string | undefined) =>
  `${promptFileName(filename)} does not open as a zip (${reason}), so Word and PowerPoint cannot open it. Save the bytes from Packer.toArrayBuffer, pres.write or fflate.zipSync as they are.`

const describeProblem = (filename: string, problem: JSValueHandle, limits: SandboxLimits) => {
  const name = promptFileName(filename)
  const flag = (key: string) => problem.getProp(key).consume((handle) => handle.toBoolean())
  const text = (key: string) =>
    problem.getProp(key).consume((handle) => (handle.isUndefined ? undefined : handle.toString()))
  if (flag('tooLarge')) {
    return tooLargeToCheck(filename)
  }
  if (flag('unzipsTooLarge')) {
    return unzipsTooLarge(filename, limits)
  }
  const badName = text('badName')
  if (badName !== undefined) {
    return `${name} has a part named ${JSON.stringify(badName.slice(0, 100))}, which Office does not accept. Name each part as a path inside the zip, without a leading "/", "\\", ":", "." or ".." folders, then call the tool again.`
  }
  const duplicate = text('duplicate')
  if (duplicate !== undefined) {
    return `${name} has two parts named ${JSON.stringify(duplicate.slice(0, 100))}, ignoring case, which Office does not accept. Keep one part under each name, then call the tool again.`
  }
  const macros = problem.getProp('macros').consume((handle) => (handle.isUndefined ? undefined : handle.toBoolean()))
  if (macros !== undefined) {
    // Never ask for .xlsm here: that would turn a workbook into one with macros.
    return macros
      ? `${name} has no macros, and Excel opens an .xlsm file only when it has them. Save it as .xlsx, then call the tool again.`
      : `${name} is marked as a workbook with macros, which Excel does not open as .xlsx. Save a workbook under the extension of the file it was opened from, or as .xlsx without macros, then call the tool again.`
  }
  const part = text('part')
  if (flag('dde')) {
    return `${name} has a DDE field in ${part}, which can run a program when the file opens, so it was not saved. Remove the field; if it came from the user's file, tell the user why it cannot be saved here.`
  }
  const added = text('added')
  if (added !== undefined) {
    return addedProblem(filename, added, part, text('detail'))
  }
  const changed = text('changed')
  if (changed !== undefined) {
    return changedProblem(filename, changed, part)
  }
  if (flag('addedMacros')) {
    return `${name} was not saved: the script added or changed the macros in ${part}. This tool keeps the macros of a file it read exactly as they are and never adds or changes any. Explain to the user what was refused and why.`
  }
  const reason = text('reason')
  return part === undefined
    ? notAZip(filename, reason)
    : `${name} would not open: its part ${part} is not valid XML (${reason}). Escape &, <, > and " in text and in attribute values such as font names, then call the tool again.`
}

/** The parts of a zip by name, or `undefined` for bytes that are not one, such as a CSV the script read. */
const checksumsOf = (bytes: Uint8Array) => {
  try {
    return partChecksums(bytes)
  } catch {
    return undefined
  }
}

/** A saved file whose every part, compared one by one since rezipping changes the bytes, is that of an input. */
const findUnchanged = (files: SavedFile[], inputs: readonly SandboxInput[]) => {
  const inputParts = inputs.flatMap(({ bytes }) => checksumsOf(bytes) ?? [])
  return files.find((file) => {
    const parts = checksumsOf(file.bytes)
    return (
      parts !== undefined &&
      inputParts.some(
        (input) => input.size === parts.size && [...parts].every(([part, sum]) => input.get(part) === sum),
      )
    )
  })
}

/** A zip's parts, unpacked within what `budget` has left, which they then use up. */
const unpack = (zip: Uint8Array, budget: { bytes: number }) => {
  const parts = unzipWithinLimits(zip, { bytes: budget.bytes, parts: 0xffff })
  budget.bytes -= [...parts.values()].reduce((total, part) => total + part.byteLength, 0)
  return parts
}

const isZip = (data: Uint8Array) => data[0] === 0x50 && data[1] === 0x4b && data[2] === 3 && data[3] === 4

const isXmlSpace = (byte: number) => byte === 0x20 || byte === 0x09 || byte === 0x0a || byte === 0x0d

/** A part's text, if Office could read it as XML: UTF-16 after its byte-order mark, or UTF-8 from a first `<`. */
const xmlTextOf = (data: Uint8Array) => {
  if ((data[0] === 0xff && data[1] === 0xfe) || (data[0] === 0xfe && data[1] === 0xff)) {
    return new TextDecoder(data[0] === 0xff ? 'utf-16le' : 'utf-16be').decode(data)
  }
  const utf8Mark = data[0] === 0xef && data[1] === 0xbb && data[2] === 0xbf ? 3 : 0
  return data.subarray(utf8Mark).find((byte) => !isXmlSpace(byte)) === 0x3c ? new TextDecoder().decode(data) : undefined
}

type PartFormula = { part: string; formula: string }

/**
 * Whether a package's content types make it a Word or PowerPoint file, not a workbook. Office Math writes a fraction
 * as `<m:f>`, so such a file's own parts are not scanned as a workbook's; a workbook inside it still is.
 */
const isDocumentOrDeck = (parts: Map<string, Uint8Array>) => {
  const types = [...parts].find(([name]) => /^\[content_types\]\.xml$/i.test(name))?.[1]
  const text = decodeXml((types && xmlTextOf(types)) ?? '')
  return (
    /(wordprocessingml|presentationml|ms-word|ms-powerpoint)\.[\w.]*main\+xml/i.test(text) &&
    !/(spreadsheetml|ms-excel)\.[\w.]*main/i.test(text)
  )
}

/**
 * Each formula in these parts that fetches data from outside the file, with its part. A part that is a zip, such as
 * the workbook behind a chart, is unpacked within `budget` and scanned too, unless `isKept` says a file the run read
 * holds it as it is, with the same formulas; one that does not unpack throws.
 */
const fetchingFormulas = (
  parts: Map<string, Uint8Array>,
  budget: { bytes: number },
  isKept: (data: Uint8Array) => boolean,
): PartFormula[] => {
  const scansText = !isDocumentOrDeck(parts)
  return [...parts].flatMap(([name, data]) => {
    if (isZip(data)) {
      return isKept(data)
        ? []
        : fetchingFormulas(unpack(data, budget), budget, isKept).map(({ part, formula }) => ({
            part: `${name}: ${part}`,
            formula,
          }))
    }
    const text = scansText ? xmlTextOf(data) : undefined
    return text === undefined ? [] : externalDataFormulas(text).map((formula) => ({ part: name, formula }))
  })
}

/** The fetching formulas of a zip and the zips inside it, which together unpack within `unzipBytes` or throw. */
const fetchingFormulasOf = (zip: Uint8Array, limits: SandboxLimits, isKept: (data: Uint8Array) => boolean) => {
  const budget = { bytes: limits.unzipBytes }
  return fetchingFormulas(unpack(zip, budget), budget, isKept)
}

/**
 * Whether `data` is byte for byte a part of one of these zips. The parts are listed once from their central
 * directories, and only those of the same size are unpacked: the saved zip's own checksums are the script's to write.
 */
const isPartOf = (zips: readonly SandboxInput[]) => {
  let sized: { zip: Uint8Array; name: string; size: number }[] | undefined
  return (data: Uint8Array) =>
    (sized ??= zips.flatMap(({ bytes }) =>
      [...(checksumsOf(bytes) ?? [])].map(([name, sum]) => ({ zip: bytes, name, size: Number(sum.split(':')[1]) })),
    )).some(({ zip, name, size }) => {
      if (size !== data.length) {
        return false
      }
      try {
        // Only this part, whose size is known, is unpacked, so no byte limit is needed.
        const part = unzipWithinLimits(zip, { bytes: Infinity, parts: 0xffff }, (entry) => entry === name).get(name)
        // A stored part may declare more bytes than it holds, so the length is compared too.
        return part?.length === data.length && part.every((byte, index) => byte === data[index])
      } catch {
        return false
      }
    })
}

/** The fetching formulas the inputs hold; one that is not a zip, or is damaged, holds none. */
const keptFormulas = (inputs: readonly SandboxInput[], limits: SandboxLimits) =>
  new Set(
    inputs.flatMap(({ bytes }) => {
      try {
        return fetchingFormulasOf(bytes, limits, () => false).map(({ formula }) => formula)
      } catch {
        return []
      }
    }),
  )

/**
 * Why a saved zip would unpack past `unzipBytes`, found by unpacking every part with each stopped at the size it
 * declares, so a part that understates its size fails as damaged instead of unpacking in full in another program.
 * The parts are then scanned for a formula that fetches outside data, which no input had (see `externalDataFormulas`):
 * here, because a sheet too large for the check VM to parse in time takes the Worker milliseconds.
 */
const findUnpackProblem = (files: SavedFile[], inputs: readonly SandboxInput[], limits: SandboxLimits) => {
  let kept: Set<string> | undefined
  const isInputPart = isPartOf(inputs)
  for (const { filename, bytes } of files) {
    try {
      const formulas = fetchingFormulasOf(bytes, limits, isInputPart)
      if (formulas.length > 0) {
        kept ??= keptFormulas(inputs, limits)
        const added = formulas.find(({ formula }) => !kept?.has(formula))
        if (added !== undefined) {
          return addedProblem(filename, 'formula', added.part, added.formula)
        }
      }
    } catch (error) {
      return error instanceof ZipLimitError && error.limit === 'bytes'
        ? unzipsTooLarge(filename, limits)
        : notAZip(filename, error instanceof Error ? error.message : String(error))
    }
  }
  return undefined
}

/** `true` for a name stored as .xlsm (`report.xlsm.` is stored as `report.xlsm`), `false` for .xlsx, `null` otherwise. */
const macrosExpected = (filename: string) => {
  const { extension } = safeFileName(filename)
  return extension === 'xlsx' || extension === 'xlsm' ? extension === 'xlsm' : null
}

/**
 * Why Word, Excel or PowerPoint would refuse one of the saved files, or why it is not safe to hand over, worded for
 * the model. Returns `undefined` when every file passes these checks:
 * - its zip opens, unzips within `unzipBytes` and has valid part names, no two alike but for case;
 * - every XML part parses, and none holds a DDE field or link;
 * - a workbook's extension matches whether it has macros;
 * - every external template, link or OLE object has the type and target of one an input had;
 * - every part behind a macro, OLE, imported-chunk, ActiveX or data-connection relationship, or typed as macros, is
 *   byte for byte one an input held as the same kind; an embedded package that is not passes these checks itself;
 * - every Word field that fills itself from outside the file, such as INCLUDEPICTURE, or whose name Word may read
 *   otherwise than this check, is one an input had;
 * - every part with a mouse-over action, an OLE verb command or a Power Query is byte for byte an input's XML part,
 *   and so are its relationships;
 * - every formula that fetches outside data, such as WEBSERVICE, is one an input had, outside a Word or PowerPoint
 *   file's own parts;
 * - it is not an input saved unchanged.
 *
 * The files are the model's own bytes, so their XML is parsed in a fresh VM with its own memory limit and the
 * script's deadline, never on the Worker's heap. Only the final unzip, bounded by `unzipBytes`, and the formula scan
 * of what it unpacked run on the Worker.
 * A file in `fromExcelize` has only the listed parts parsed: Excelize wrote the rest, and parsing a large workbook
 * would take most of the script's time.
 */
export const findBrokenFile = async (
  runtime: SandboxRuntime,
  files: SavedFile[],
  limits: SandboxLimits,
  deadline: number,
  fromExcelize: ReadonlyMap<SavedFile, string[]> = new Map(),
  inputs: readonly SandboxInput[] = [],
): Promise<string | undefined> => {
  if (files.length === 0) {
    return undefined
  }
  const memoryLimit = checkMemoryFactor * limits.memoryBytes
  // As in the script VM, loading the libraries is the app's own work and is not cut short.
  let loaded = false
  const vm = await QuickJS.create({
    wasm: runtime.wasm,
    extensions: runtime.extensions,
    memoryLimit,
    interruptHandler: () => loaded && performance.now() > deadline,
  })
  try {
    // The VM keeps its own reference to a returned handle, so each file's copy is released before the next.
    let current: JSValueHandle | undefined
    const define = (name: string, from: readonly { bytes: Uint8Array }[]) => {
      const read = vm.newFunction(name, (index) => {
        current?.dispose()
        current = vm.newUint8Array(from[index.toNumber()].bytes)
        return current
      })
      vm.setProp(vm.global, name, read)
      read.dispose()
    }
    define('__savedFile', files)
    define('__inputFile', inputs)
    vm.evalCode(runtime.ooxmlLibrary, 'ooxml.js').dispose()
    vm.evalCode(checker(memoryLimit, limits.unzipBytes), 'check.js').dispose()
    loaded = true
    for (const [index, file] of files.entries()) {
      const { filename } = file
      try {
        const problem = vm
          .evalCode(
            `__check(${index}, ${macrosExpected(filename)}, ${JSON.stringify(fromExcelize.get(file) ?? null)}, ${inputs.length})`,
          )
          .consume((result) => (result.isUndefined ? undefined : describeProblem(filename, result, limits)))
        if (problem !== undefined) {
          return problem
        }
      } catch (error) {
        if (/interrupted/i.test(String(error))) {
          return `Checking ${promptFileName(filename)} did not finish within the ${limits.timeoutMs / 1000}-second limit, which the script and the check share. Make the script finish sooner or save smaller files, then call the tool again.`
        }
        if (!/out of memory|stack overflow/i.test(String(error))) {
          throw error
        }
        return tooLargeToCheck(filename)
      }
    }
  } finally {
    vm.dispose()
  }
  const unpacked = findUnpackProblem(files, inputs, limits)
  if (unpacked !== undefined) {
    return unpacked
  }
  const unchanged = findUnchanged(files, inputs)
  return unchanged === undefined
    ? undefined
    : `${promptFileName(unchanged.filename)} is the same as a file this run read: the edit changed nothing, so it was not saved. Make the change the user asked for, or tell the user that nothing changed.`
}
