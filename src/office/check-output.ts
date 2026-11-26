/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { partChecksums, unzipWithinLimits, ZipLimitError } from '@/files/unzip-within-limits'
import { promptFileName, safeFileName } from '@/lib/safe-file-name'
import { type JSValueHandle, QuickJS } from 'quickjs-wasi'
import type { SandboxLimits } from './constants'
import { decodeXml, type ExternalDataFormula, externalDataFormulas } from './formula-cache'
import type { SandboxInput, SandboxRuntime, SavedFile } from './sandbox'

// A DOM in QuickJS takes several times the memory of its XML; a 1,000-page document.xml is about 3.5 MB.
const checkMemoryFactor = 4

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
  [
    'ddeFormula',
    'a DDE formula (app|topic!item, or the DDE function), which asks another program for data and can start it when the workbook calculates',
  ],
])

/** `detail`, the field code or formula refused, lets the model tell its own addition from the user's content it moved. */
const addedProblem = (filename: string, added: string, part: string | undefined, detail?: string) => {
  // As written, spacing included: the check compares it so, and a spacing change may be all that differs.
  const quoted = detail === undefined ? '' : ` (${JSON.stringify(detail.slice(0, 80))}${detail.length > 80 ? '…' : ''})`
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

type PartFormula = ExternalDataFormula & { part: string }

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
        : fetchingFormulas(unpack(data, budget), budget, isKept).map(({ part, ...found }) => ({
            ...found,
            part: `${name}: ${part}`,
          }))
    }
    const text = scansText ? xmlTextOf(data) : undefined
    return text === undefined ? [] : externalDataFormulas(text).map((found) => ({ ...found, part: name }))
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
        return fetchingFormulasOf(bytes, limits, () => false).map(({ key }) => key)
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
        const added = formulas.find(({ key }) => !kept?.has(key))
        if (added !== undefined) {
          return addedProblem(filename, added.dde ? 'ddeFormula' : 'formula', added.part, added.formula)
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
 * - every formula that fetches outside data, such as WEBSERVICE or a DDE request, is one an input had, outside a
 *   Word or PowerPoint file's own parts;
 * - it is not an input saved unchanged.
 *
 * The files are the model's own bytes, so their XML is parsed in a fresh VM with its own memory limit and the
 * script's deadline, never on the Worker's heap; the VM runs `check-package.ts`. Only the final unzip, bounded by
 * `unzipBytes`, and the formula scan of what it unpacked run on the Worker.
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
    vm.evalCode(runtime.checkScript, 'check.js').dispose()
    loaded = true
    for (const [index, file] of files.entries()) {
      const { filename } = file
      try {
        const problem = vm
          .evalCode(
            `__check(${index}, ${macrosExpected(filename)}, ${JSON.stringify(fromExcelize.get(file) ?? null)}, ${inputs.length}, ${memoryLimit}, ${limits.unzipBytes})`,
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
