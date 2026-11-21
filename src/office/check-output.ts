/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { partChecksums, unzipWithinLimits, ZipLimitError } from '@/files/unzip-within-limits'
import { promptFileName } from '@/lib/safe-file-name'
import { type JSValueHandle, QuickJS } from 'quickjs-wasi'
import type { SandboxLimits } from './constants'
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
    // A legacy encoding such as windows-1252 writes markup in the same bytes as ASCII, so one character per byte
    // checks the XML as well as decoding it would.
    const head = declaration.exec(latin1(data.subarray(0, 256)))?.[1]
    if (encoding === 'utf-8' && head !== undefined && !/^utf-(8|16)$/i.test(head)) {
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
  const attribute = (node, name) => {
    for (let i = 0; i < node.attributes.length; i += 1) {
      if (node.attributes[i].localName === name) return node.attributes[i].value
    }
  }
  // Each field's code on its own: a simple field's, or the runs between a field's begin and separate marks, which
  // may split it anywhere. Runs outside any field are joined into one more code.
  const fieldCodes = (doc) => {
    const codes = Array.from(doc.getElementsByTagNameNS('*', 'fldSimple'), (field) => attribute(field, 'instr') ?? '')
    const open = []
    let stray = ''
    for (let node = doc.documentElement; node !== null; ) {
      const field = open[open.length - 1]
      if (node.localName === 'fldChar') {
        const type = attribute(node, 'fldCharType')
        if (type === 'begin') open.push({ code: '', done: false })
        if (type === 'separate' && field !== undefined) field.done = true
        if (type === 'end' && field !== undefined) codes.push(open.pop().code)
      } else if (node.localName === 'instrText') {
        if (field === undefined) stray += node.textContent
        else if (!field.done) field.code += node.textContent
      }
      if (node.firstChild !== null) {
        node = node.firstChild
        continue
      }
      while (node !== null && node.nextSibling === null) node = node.parentNode
      node = node === null ? null : node.nextSibling
    }
    return [...codes, ...open.map(({ code }) => code), stray]
  }
  // A DDE field runs a program when a document opens, as does a DDE link in a workbook.
  const hasDde = (doc) =>
    doc.getElementsByTagNameNS('*', 'ddeLink').length > 0 ||
    fieldCodes(doc).some((code) => /^\\s*DDE(AUTO)?\\b/i.test(code))
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
  // Content that Office fetches from outside the file, or runs. A hyperlink opens only on a click, so it does not count.
  const activeKind = (relationship) => {
    const type = relationship.getAttribute('Type') ?? ''
    if (/\\/oleObject$/.test(type)) return 'ole'
    if (!/^external$/i.test(relationship.getAttribute('TargetMode') ?? '') || /\\/hyperlink$/.test(type)) return undefined
    return /\\/attachedTemplate$/.test(type) ? 'template' : 'link'
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
  // Each piece of active content, keyed by the kind of document it is in, read from every relationships part.
  const activeContent = (bytes) => {
    const names = partNames(bytes)
    const documentKind = ['word', 'xl', 'ppt'].find((folder) => names.some((name) => name.startsWith(folder + '/')))
    return names
      .filter((name) => /\\.rels$/i.test(name))
      .flatMap((part) => {
        // Office cannot read this part either, so it points nowhere.
        try {
          const data = fflate.unzipSync(bytes, { filter: (file) => file.name === part })[part]
          const doc = new xmldom.DOMParser({ onError: () => {} }).parseFromString(decode(data), 'text/xml')
          return Array.from(doc.getElementsByTagNameNS('*', 'Relationship'), activeKind)
            .filter((kind) => kind !== undefined)
            .map((kind) => ({ key: documentKind + ':' + kind, kind, part }))
        } catch (error) {
          reason(error)
          return []
        }
      })
  }
  let inputContent
  // Read once per check, from inputs the user gave, so a damaged one counts as having none.
  const inputKeys = (count) =>
    (inputContent ??= new Set(
      Array.from({ length: count }, (_, index) => {
        try {
          return activeContent(__inputFile(index)).map(({ key }) => key)
        } catch (error) {
          reason(error)
          return []
        }
      }).flat(),
    ))
  let inputMacros
  // The bytes of every macro part the inputs hold, read once per check; a damaged input holds none.
  const keptMacros = (count) =>
    (inputMacros ??= Array.from({ length: count }, (_, index) => {
      try {
        const bytes = __inputFile(index)
        const types = fflate.unzipSync(bytes, { filter: ({ name }) => name === '[Content_Types].xml' })['[Content_Types].xml']
        const doc = new xmldom.DOMParser({ onError: () => {} }).parseFromString(decode(types), 'text/xml')
        return macroParts(bytes, doc, partNames(bytes)).map(([, data]) => data)
      } catch (error) {
        reason(error)
        return []
      }
    }).flat())
  // \`macros\` is true for a .xlsm name, false for .xlsx and null for anything else; Excel opens a workbook only when
  // its content type agrees. \`only\` lists the XML parts to parse, besides the content types; null parses them all.
  // \`inputs\` is how many files the run read: active content none of them had is the script's own.
  globalThis.__check = (index, macros, only, inputs) => {
    const bytes = __savedFile(index)
    const all = []
    const names = []
    const sizes = new Map()
    let declared = 0
    let total = 0
    let badName
    let types
    // Excelize rewrites an external link it read, so its parts are parsed for a DDE link however the file was made.
    const parsed = (name) =>
      only === null || only.includes(name) || isContentTypes(name) || /^xl\\/externalLinks\\//.test(name)
    try {
      fflate.unzipSync(bytes, {
        filter: ({ name, originalSize }) => {
          all.push(name)
          sizes.set(name, originalSize)
          badName ??= isBadName(name) ? name : undefined
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
    if (declared > ${maxXmlBytes}) {
      return { tooLarge: true }
    }
    if (total > ${maxUnzipBytes}) {
      return { unzipsTooLarge: true }
    }
    for (const name of names) {
      let data
      try {
        data = fflate.unzipSync(bytes, { filter: (file) => file.name === name })[name]
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
    const added = activeContent(bytes).find(({ key }) => !inputKeys(inputs).has(key))
    if (added !== undefined) {
      return { added: added.kind, part: added.part }
    }
    // A script may keep the macros of a file it read, byte for byte, but never add or change any.
    const macro = types && macroParts(bytes, types, all).find(([, data]) => !keptMacros(inputs).some((kept) => sameBytes(data, kept)))
    if (macro) {
      return { addedMacros: true, part: macro[0] }
    }
  }
})()`

const tooLargeToCheck = (filename: string) =>
  `The XML in ${promptFileName(filename)} is too large to check. Make the file smaller or split it into several files, then call the tool again.`

/** Active content a script may not add, described as the model is told it. */
const addedContent = new Map([
  ['template', 'a template linked from outside the file, which Word downloads when the file opens'],
  ['link', 'a link to content outside the file, which Office can fetch when the file opens'],
  ['ole', 'an OLE object, which can run a program when it is opened'],
])

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
    return `${name} was not saved: the script added ${addedContent.get(added)}, in ${part}, and no file it read of this type had one. This tool does not add such content to a file. Explain to the user what was refused and why.`
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

/**
 * Why a saved zip would unpack past `unzipBytes`, found by unpacking every part with each stopped at the size it
 * declares, so a part that understates its size fails as damaged instead of unpacking in full in another program.
 */
const findUnpackProblem = (files: SavedFile[], limits: SandboxLimits) => {
  for (const { filename, bytes } of files) {
    try {
      unzipWithinLimits(bytes, { bytes: limits.unzipBytes, parts: 0xffff })
    } catch (error) {
      return error instanceof ZipLimitError && error.limit === 'bytes'
        ? unzipsTooLarge(filename, limits)
        : notAZip(filename, error instanceof Error ? error.message : String(error))
    }
  }
  return undefined
}

/** `true` for a .xlsm name, `false` for .xlsx, `null` for any other file. */
const macrosExpected = (filename: string) => {
  const extension = /\.(xlsx|xlsm)$/i.exec(filename)?.[1].toLowerCase()
  return extension === undefined ? null : extension === 'xlsm'
}

/**
 * Why Word, Excel or PowerPoint would refuse one of the saved files, or why it is not safe to hand over, worded for
 * the model. Returns `undefined` when every file passes these checks:
 * - its zip opens, unzips within `unzipBytes` and has valid part names;
 * - every XML part parses, and none holds a DDE field or link;
 * - a workbook's extension matches whether it has macros;
 * - it adds no remote template, external link or OLE object that no input of its type had;
 * - every macro part matches an input's byte for byte;
 * - it is not an input saved unchanged.
 *
 * The files are the model's own bytes, so their XML is parsed in a fresh VM with its own memory limit and the
 * script's deadline, never on the Worker's heap. Only the final unzip, bounded by `unzipBytes`, runs on the Worker.
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
  const unpacked = findUnpackProblem(files, limits)
  if (unpacked !== undefined) {
    return unpacked
  }
  const unchanged = findUnchanged(files, inputs)
  return unchanged === undefined
    ? undefined
    : `${promptFileName(unchanged.filename)} is the same as a file this run read: the edit changed nothing, so it was not saved. Make the change the user asked for, or tell the user that nothing changed.`
}
