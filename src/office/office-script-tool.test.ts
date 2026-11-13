/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { afterAll, describe, expect, it, spyOn } from 'bun:test'
import { DOMParser } from '@xmldom/xmldom'
import { strToU8, zipSync } from 'fflate'
import JSZip from 'jszip'
import mammoth from 'mammoth'
import { docxMime, pptxMime } from '@/files/transformers'
import type { StoredFile } from '@/lib/file-blob-storage'
import { findBrokenFile } from './check-output'
import { type SandboxLimits, sandboxLimits } from './constants'
import { createOfficeScriptTool, type OfficeScriptOutput, type OfficeScriptToolDeps } from './office-script-tool'
import { runSandboxedScript, type SandboxJob, type SandboxResult } from './sandbox'
import { loadTestSandboxRuntime } from './sandbox-test-runtime'
import type { ReadWorkspaceFile, ThreadFile } from './script-inputs'

type Runner = (job: SandboxJob, limits: SandboxLimits) => Promise<SandboxResult>

const runtime = await loadTestSandboxRuntime()

const inProcess: Runner = (job, limits) => runSandboxedScript(runtime, job, limits)

/*
 * The same runs in a Bun Worker without `Symbol.dispose`, standing in for system WebKit. One run at a time,
 * so a run that blocks the Worker can't eat into the next one's time limit.
 */
const worker = new Worker(new URL('./no-symbol-dispose.test-worker.ts', import.meta.url))
const workerReady = new Promise<void>((resolve) => {
  worker.onmessage = () => resolve()
})
let queue: Promise<unknown> = workerReady
const withoutSymbolDispose: Runner = (job, limits) => {
  const run = queue.then(
    () =>
      new Promise<SandboxResult>((resolve) => {
        worker.onmessage = ({ data }: MessageEvent<SandboxResult>) => resolve(data)
        worker.postMessage({ job, limits })
      }),
  )
  queue = run
  return run
}

afterAll(() => worker.terminate())

const docxScript = (filename: string) => `
const { Document, Packer, Paragraph, HeadingLevel, TextRun } = docx
const doc = new Document({ sections: [{ children: [
  new Paragraph({ text: 'Quarterly report', heading: HeadingLevel.HEADING_1 }),
  new Paragraph({ children: [new TextRun({ text: 'Revenue up 12%', bold: true })] }),
] }] })
saveFile(${JSON.stringify(filename)}, await Packer.toArrayBuffer(doc))
`

const pptxScript = `
const pres = new PptxGenJS()
const slide = pres.addSlide()
slide.addText('Hello deck', { x: 1, y: 0.5, w: 8, h: 1, fontSize: 32 })
slide.addChart(pres.ChartType.bar, [{ name: 'Sales', labels: ['Q1', 'Q2'], values: [10, 20] }], { x: 1, y: 2, w: 6, h: 3 })
saveFile('deck.pptx', await pres.write({ outputType: 'uint8array' }))
`

/** The smallest bytes that pass the output check, for runs that are about something else. */
const emptyZip = 'fflate.zipSync({})'

/** Replace text in `word/document.xml` of an input, then save the result under `saveAs`. */
const replaceTextScript = (input: string, from: string, to: string, saveAs = input) => `
const parts = fflate.unzipSync(readFile(${JSON.stringify(input)}))
const xml = fflate.strFromU8(parts['word/document.xml'])
parts['word/document.xml'] = fflate.strToU8(xml.replace(${JSON.stringify(from)}, ${JSON.stringify(to)}))
saveFile(${JSON.stringify(saveAs)}, fflate.zipSync(parts))
`

// Stands in for the IndexedDB attachment store, whose Blob values don't survive fake-indexeddb under happy-dom.
const attachmentStore = new Map<string, StoredFile>()
const storeFiles = async (files: StoredFile[]) => {
  files.forEach((file) => attachmentStore.set(file.id, file))
}

const stored = (id: string): StoredFile => {
  const file = attachmentStore.get(id)
  expect(file).toBeDefined()
  return file!
}

const fixture = async (name: string) =>
  new Uint8Array(await Bun.file(new URL(`./test-fixtures/${name}`, import.meta.url)).arrayBuffer())

/** A file in the store, as the user's attachment or an earlier output. */
const storeAttachment = (filename: string, bytes: Uint8Array<ArrayBuffer>, createdAt = Date.now()): StoredFile => {
  const mimeType = filename.endsWith('.pptx') ? pptxMime : docxMime
  const file = {
    id: crypto.randomUUID(),
    filename,
    mimeType,
    size: bytes.byteLength,
    createdAt,
    blob: new Blob([bytes]),
  }
  attachmentStore.set(file.id, file)
  return file
}

const zipOf = async (file: StoredFile) => JSZip.loadAsync(await file.blob.arrayBuffer())

const partOf = async (file: StoredFile, part: string) => {
  const text = await (await zipOf(file)).file(part)?.async('string')
  expect(text).toBeDefined()
  return text!
}

const textOf = async (file: StoredFile) =>
  // Bun resolves mammoth's Node build, which reads a Buffer.
  (await mammoth.extractRawText({ buffer: Buffer.from(await file.blob.arrayBuffer()) })).value

const count = (xml: string, pattern: RegExp) => xml.match(pattern)?.length ?? 0

const mib = 1024 * 1024

/** A Word-shaped zip whose document part is `xml`. */
const zipWith = (xml: string) =>
  zipSync({ '[Content_Types].xml': strToU8('<Types/>'), 'word/document.xml': strToU8(xml) })

/** `xml` in UTF-16 after a byte-order mark: little-endian as returned, big-endian after `.swap16()`. */
const utf16 = (xml: string) => Buffer.from(`\uFEFF${xml}`, 'utf16le')

/** Overwrite the uncompressed size the central directory gives the zip's last entry. */
const claimSize = (zip: Uint8Array<ArrayBuffer>, size: number) => {
  const central = Buffer.from(zip).lastIndexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]))
  new DataView(zip.buffer).setUint32(central + 24, size, true)
  return zip
}

const tooLargeToCheck =
  'The XML in "a.docx" is too large to check. Make the file smaller or split it into several files, then call the tool again.'

const checkOutOfTime = (seconds: number) =>
  `Checking "a.docx" did not finish within the ${seconds}-second limit, which the script and the check share. Make the script finish sooner or save smaller files, then call the tool again.`

describe.each([
  ['with Symbol.dispose', inProcess],
  ['without Symbol.dispose', withoutSymbolDispose],
] as const)('run_office_script %s', (_, runner) => {
  const tool = (deps: OfficeScriptToolDeps = {}, limits: Partial<SandboxLimits> = {}) =>
    createOfficeScriptTool({ runScript: (job) => runner(job, { ...sandboxLimits, ...limits }), storeFiles, ...deps })

  const call = (deps: OfficeScriptToolDeps, script: string, inputs?: string[]) =>
    tool(deps).execute({ script, inputs }) as Promise<OfficeScriptOutput>

  const run = (script: string, limits: Partial<SandboxLimits> = {}) =>
    tool({}, limits).execute({ script }) as Promise<OfficeScriptOutput>

  const okFiles = async (result: Promise<OfficeScriptOutput>) => {
    const output = await result
    if (!output.ok) {
      throw new Error(output.error)
    }
    return output
  }

  const runOk = (script: string) => okFiles(run(script))

  const errorOf = async (script: string, limits?: Partial<SandboxLimits>) => {
    const result = await run(script, limits)
    expect(result.ok).toBe(false)
    return result.ok ? '' : result.error
  }

  /** The thread's files are whatever these tests put in the store. */
  const thread = { listThreadFiles: async () => [...attachmentStore.values()] }

  /** Save `bytes` as they are, so the output check sees exactly them, and return why the run failed. */
  const checkErrorOf = async (bytes: Uint8Array<ArrayBuffer>, limits: Partial<SandboxLimits> = {}) => {
    const input = storeAttachment('input.docx', bytes)
    const result = (await tool({ listThreadFiles: async () => [input] }, limits).execute({
      script: `saveFile('a.docx', readFile('input.docx'))`,
      inputs: ['input.docx'],
    })) as OfficeScriptOutput
    expect(result.ok).toBe(false)
    return result.ok ? '' : result.error
  }

  it('saves a DOCX that a second reader opens', async () => {
    const { files } = await runOk(docxScript('report.docx'))

    expect(files).toEqual([
      { id: expect.any(String), filename: 'report.docx', mimeType: docxMime, edited: false, savedAs: 'report.docx' },
    ])
    const file = stored(files[0].id)
    expect(file).toMatchObject({ filename: 'report.docx', mimeType: docxMime })
    expect(file.size).toBeGreaterThan(0)
    const text = await textOf(file)
    expect(text).toContain('Quarterly report')
    expect(text).toContain('Revenue up 12%')
  })

  it('saves a PPTX whose slide and chart parts unzip', async () => {
    const { files } = await runOk(pptxScript)

    expect(files).toEqual([
      { id: expect.any(String), filename: 'deck.pptx', mimeType: pptxMime, edited: false, savedAs: 'deck.pptx' },
    ])
    const zip = await zipOf(stored(files[0].id))
    expect(await zip.file('ppt/slides/slide1.xml')?.async('string')).toContain('Hello deck')
    expect(zip.file('ppt/charts/chart1.xml')).not.toBeNull()
  })

  it('adds every output as a new entry, even under a name saved before', async () => {
    const first = await runOk(`${docxScript('a.docx')}\n${pptxScript}`)
    const second = await runOk(docxScript('a.docx'))

    const ids = [...first.files, ...second.files].map(({ id }) => id)
    expect(first.files.map(({ filename }) => filename)).toEqual(['a.docx', 'deck.pptx'])
    expect(new Set(ids).size).toBe(3)
    for (const id of ids) {
      stored(id)
    }
  })

  it('stores, lists and shows each file under a name every filesystem accepts', async () => {
    const names = ['invoice\u{202E}xcod.docx', 'a:b.docx', 'CON.docx']
    const { files } = await runOk(names.map((name) => `saveFile(${JSON.stringify(name)}, ${emptyZip})`).join('\n'))

    const saved = ['invoice xcod.docx', 'a b.docx', '_CON.docx']
    expect(files.map(({ filename }) => filename)).toEqual(saved)
    expect(files.map(({ id }) => stored(id).filename)).toEqual(saved)
    expect(files.map(({ savedAs }) => savedAs)).toEqual(names)
  })

  it('reads an attached Word file by name and saves an edited copy, leaving the original as it was', async () => {
    const original = await fixture('testComment.docx')
    const attached = storeAttachment('contract.docx', original)

    const { files } = await okFiles(
      call(
        thread,
        replaceTextScript('contract.docx', '<w:body>', '<w:body><w:p><w:r><w:t>Reviewed copy</w:t></w:r></w:p>'),
        ['contract.docx'],
      ),
    )

    expect(files).toEqual([
      { id: expect.any(String), filename: 'contract.docx', mimeType: docxMime, edited: true, savedAs: 'contract.docx' },
    ])
    expect(files[0].id).not.toBe(attached.id)
    expect(await textOf(stored(files[0].id))).toContain('Reviewed copy')
    expect(new Uint8Array(await stored(attached.id).blob.arrayBuffer())).toEqual(original)
    expect(await textOf(stored(attached.id))).not.toContain('Reviewed copy')
  })

  it('edits a file it made earlier in the thread, with no new upload', async () => {
    const { files: made } = await okFiles(call(thread, docxScript('report.docx')))

    // A later send: a new tool, which finds the file through the thread.
    const { files } = await okFiles(
      call(thread, replaceTextScript('report.docx', 'Revenue up 12%', 'Revenue up 15%'), ['report.docx']),
    )

    expect(files[0]).toMatchObject({ filename: 'report.docx', edited: true })
    expect(await textOf(stored(files[0].id))).toContain('Revenue up 15%')
    expect(await textOf(stored(made[0].id))).toContain('Revenue up 12%')
  })

  it('edits a file it made earlier in the same send, before the thread has stored it', async () => {
    const send = tool({ listThreadFiles: async () => [] })
    const made = (await send.execute({ script: docxScript('draft.docx') })) as OfficeScriptOutput
    const edited = (await send.execute({
      script: replaceTextScript('draft.docx', 'Revenue up 12%', 'Revenue up 20%'),
      inputs: ['draft.docx'],
    })) as OfficeScriptOutput

    expect(made.ok && edited.ok).toBe(true)
    const [file] = edited.ok ? edited.files : []
    expect(await textOf(stored(file.id))).toContain('Revenue up 20%')
  })

  it('reads the newest file when two share a name, and an older one by its id', async () => {
    const build = async (text: string) =>
      (await okFiles(call({}, docxScript('notes.docx').replace('Revenue up 12%', text)))).files[0]
    const older = stored((await build('Older notes')).id)
    const newer = stored((await build('Newer notes')).id)
    const threadFiles = [
      { ...older, createdAt: 1000 },
      { ...newer, createdAt: 2000 },
    ]

    const { logs, files } = await okFiles(
      call(
        { listThreadFiles: async () => threadFiles },
        `
        const text = (name) => fflate.strFromU8(fflate.unzipSync(readFile(name))['word/document.xml'])
        console.log(text('notes.docx').includes('Newer notes'), text(${JSON.stringify(older.id)}).includes('Older notes'))
        saveFile('summary.docx', readFile('notes.docx'))
        `,
        ['notes.docx', older.id],
      ),
    )

    expect(logs).toBe('true true\n')
    expect(files[0]).toMatchObject({ filename: 'summary.docx', edited: true })
  })

  it('reads data the agent prepared in its workspace, and writes nothing there', async () => {
    const workspace = new Map([['data/sales.json', new TextEncoder().encode('{"q1":10,"q2":20}')]])
    const readWorkspaceFile: ReadWorkspaceFile = async (path) => {
      const bytes = workspace.get(path)
      return bytes ? { status: 'read', bytes } : { status: 'missing' }
    }

    const { files } = await okFiles(
      call(
        { listThreadFiles: async () => [], readWorkspaceFile },
        `
        const sales = JSON.parse(new TextDecoder().decode(readFile('data/sales.json')))
        const doc = new docx.Document({ sections: [{ children: [new docx.Paragraph('Q1: ' + sales.q1 + ', Q2: ' + sales.q2)] }] })
        saveFile('sales.docx', await docx.Packer.toArrayBuffer(doc))
        `,
        ['data/sales.json'],
      ),
    )

    expect(await textOf(stored(files[0].id))).toContain('Q1: 10, Q2: 20')
    expect([...workspace.keys()]).toEqual(['data/sales.json'])
  })

  it('reads a stored file before a workspace file of the same name', async () => {
    const attached = storeAttachment('brief.docx', await fixture('testComment.docx'))
    const readWorkspaceFile: ReadWorkspaceFile = async () => ({
      status: 'read',
      bytes: new TextEncoder().encode('not the attachment'),
    })

    const { logs } = await okFiles(
      call(
        { listThreadFiles: async () => [attached], readWorkspaceFile },
        `console.log(readFile('brief.docx').length)\nsaveFile('out.docx', ${emptyZip})`,
        ['brief.docx'],
      ),
    )

    expect(logs).toBe(`${attached.size}\n`)
  })

  it('reads no workspace on the legacy pipeline, and lists the files it can read', async () => {
    const attached = storeAttachment('brief.docx', await fixture('testComment.docx'))
    const result = await call({ listThreadFiles: async () => [attached] }, `saveFile('a.docx', ${emptyZip})`, [
      'data/sales.json',
    ])

    expect(result).toEqual({
      ok: false,
      error: `No file "data/sales.json" in this chat. The files in this chat, newest first: "brief.docx" (id ${attached.id}). Name an input by its file name or its id.`,
      logs: '',
    })
  })

  it('keeps the comments and tracked changes of a Word file patched with patchDocument', async () => {
    const patchScript = (name: string) => `
      const parts = fflate.unzipSync(readFile(${JSON.stringify(name)}))
      const xml = fflate.strFromU8(parts['word/document.xml'])
      parts['word/document.xml'] = fflate.strToU8(xml.replace('<w:body>', '<w:body><w:p><w:r><w:t>Client: {{client}}</w:t></w:r></w:p>'))
      const patched = await docx.patchDocument({ outputType: 'uint8array', data: fflate.zipSync(parts), patches: {
        client: { type: docx.PatchType.PARAGRAPH, children: [new docx.TextRun({ text: 'ACME Corp', bold: true })] },
      } })
      saveFile(${JSON.stringify(name)}, patched)
    `
    const counts = async (file: StoredFile) => {
      const zip = await zipOf(file)
      const body = (await zip.file('word/document.xml')?.async('string')) ?? ''
      const comments = (await zip.file('word/comments.xml')?.async('string')) ?? ''
      return {
        comments: count(comments, /<w:comment /g),
        commentReferences: count(body, /<w:commentReference /g),
        insertions: count(body, /<w:ins /g),
        deletions: count(body, /<w:del /g),
      }
    }

    for (const [name, expected] of [
      ['testComment.docx', { comments: 1, commentReferences: 1, insertions: 0, deletions: 0 }],
      ['delins.docx', { comments: 0, commentReferences: 0, insertions: 32, deletions: 4 }],
    ] as const) {
      const attached = storeAttachment(name, await fixture(name))
      const { files } = await okFiles(call({ listThreadFiles: async () => [attached] }, patchScript(name), [name]))
      const edited = stored(files[0].id)

      expect(await counts(attached)).toEqual(expected)
      expect(await counts(edited)).toEqual(expected)
      expect(await textOf(edited)).toContain('ACME Corp')
      expect(await partOf(edited, 'word/document.xml')).not.toContain('{{client}}')
    }
  })

  it('adds a slide to a PowerPoint deck by copying one, keeping its layout', async () => {
    const attached = storeAttachment('SampleShow.pptx', await fixture('SampleShow.pptx'))
    const script = `
      const P = 'http://schemas.openxmlformats.org/presentationml/2006/main'
      const A = 'http://schemas.openxmlformats.org/drawingml/2006/main'
      const R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
      const PR = 'http://schemas.openxmlformats.org/package/2006/relationships'
      const parts = fflate.unzipSync(readFile('SampleShow.pptx'))
      const parse = (path) => new xmldom.DOMParser().parseFromString(fflate.strFromU8(parts[path]), 'application/xml')
      const save = (path, doc) => { parts[path] = fflate.strToU8(new xmldom.XMLSerializer().serializeToString(doc)) }
      const n = Object.keys(parts).filter((path) => /^ppt\\/slides\\/slide\\d+\\.xml$/.test(path)).length + 1
      const slidePath = 'ppt/slides/slide' + n + '.xml'
      const slide = parse('ppt/slides/slide1.xml')
      const texts = slide.getElementsByTagNameNS(A, 't')
      for (let i = 0; i < texts.length; i++) texts[i].textContent = 'Copied slide ' + i
      save(slidePath, slide)
      // A notes slide belongs to one slide only, so the copy goes without it.
      const rels = parse('ppt/slides/_rels/slide1.xml.rels')
      for (const rel of Array.from(rels.getElementsByTagNameNS(PR, 'Relationship'))) {
        if (rel.getAttribute('Type').endsWith('/notesSlide')) rel.parentNode.removeChild(rel)
      }
      save('ppt/slides/_rels/slide' + n + '.xml.rels', rels)
      const types = parse('[Content_Types].xml')
      const override = types.createElementNS('http://schemas.openxmlformats.org/package/2006/content-types', 'Override')
      override.setAttribute('PartName', '/' + slidePath)
      override.setAttribute('ContentType', 'application/vnd.openxmlformats-officedocument.presentationml.slide+xml')
      types.documentElement.appendChild(override)
      save('[Content_Types].xml', types)
      const presRels = parse('ppt/_rels/presentation.xml.rels')
      const ids = Array.from(presRels.getElementsByTagNameNS(PR, 'Relationship')).map((rel) => Number(rel.getAttribute('Id').replace(/\\D/g, '')))
      const rId = 'rId' + (Math.max(...ids) + 1)
      const rel = presRels.createElementNS(PR, 'Relationship')
      rel.setAttribute('Id', rId)
      rel.setAttribute('Type', R + '/slide')
      rel.setAttribute('Target', 'slides/slide' + n + '.xml')
      presRels.documentElement.appendChild(rel)
      save('ppt/_rels/presentation.xml.rels', presRels)
      const pres = parse('ppt/presentation.xml')
      const list = pres.getElementsByTagNameNS(P, 'sldIdLst')[0]
      const slideIds = Array.from(list.getElementsByTagNameNS(P, 'sldId')).map((id) => Number(id.getAttribute('id')))
      const slideId = pres.createElementNS(P, 'p:sldId')
      slideId.setAttribute('id', String(Math.max(...slideIds) + 1))
      slideId.setAttributeNS(R, 'r:id', rId)
      list.appendChild(slideId)
      save('ppt/presentation.xml', pres)
      saveFile('SampleShow.pptx', fflate.zipSync(parts))
    `

    const { files } = await okFiles(call({ listThreadFiles: async () => [attached] }, script, ['SampleShow.pptx']))

    expect(files[0]).toMatchObject({ filename: 'SampleShow.pptx', mimeType: pptxMime, edited: true })
    const deck = stored(files[0].id)
    const layoutOf = (rels: string) => rels.match(/Target="([^"]*slideLayout[^"]*)"/)?.[1]
    const sourceRels = await partOf(deck, 'ppt/slides/_rels/slide1.xml.rels')
    const copyRels = await partOf(deck, 'ppt/slides/_rels/slide3.xml.rels')
    expect(layoutOf(copyRels)).toBe(layoutOf(sourceRels))
    expect(layoutOf(copyRels)).toBeDefined()
    expect(copyRels).not.toContain('notesSlide')
    expect(await partOf(deck, 'ppt/slides/slide3.xml')).toContain('Copied slide 0')
    expect(await partOf(deck, '[Content_Types].xml')).toContain('PartName="/ppt/slides/slide3.xml"')
    const presRels = await partOf(deck, 'ppt/_rels/presentation.xml.rels')
    const rId = presRels.match(/Id="(rId\d+)"[^>]*Target="slides\/slide3\.xml"/)?.[1]
    expect(rId).toBeDefined()
    const presentation = await partOf(deck, 'ppt/presentation.xml')
    expect(count(presentation, /<p:sldId /g)).toBe(3)
    expect(presentation).toContain(`r:id="${rId}"`)
    expect(await partOf(attached, 'ppt/presentation.xml')).not.toContain(`r:id="${rId}"`)
  })

  it('refuses to save a file whose zip does not open or whose XML does not parse', async () => {
    const before = attachmentStore.size

    expect(await errorOf(`saveFile('broken.docx', new Uint8Array([1, 2, 3]))`)).toStartWith(
      '"broken.docx" does not open as a zip',
    )
    const fontError = await errorOf(`
      const pres = new PptxGenJS()
      pres.addSlide().addText('Hello', { x: 1, y: 1, w: 4, h: 1, fontFace: 'Ari"al' })
      saveFile('deck.pptx', await pres.write({ outputType: 'uint8array' }))
    `)
    expect(fontError).toStartWith('"deck.pptx" would not open: its part ppt/slides/slide1.xml is not valid XML')
    expect(fontError).toContain('Escape &, <, > and " in text and in attribute values such as font names')
    expect(attachmentStore.size).toBe(before)
  })

  it.each([
    ['an undefined entity', '<a>&foo;</a>'],
    ['an unquoted attribute', '<a b=c/>'],
  ])('refuses %s, which the parser accepts by default', async (_, xml) => {
    // The default handler logs these and goes on; this one does the same without the log.
    expect(() => new DOMParser({ onError: () => {} }).parseFromString(xml, 'text/xml')).not.toThrow()
    expect(await checkErrorOf(zipWith(xml))).toStartWith(
      '"a.docx" would not open: its part word/document.xml is not valid XML (',
    )
  })

  it('saves an edit to an attached file whose untouched parts are UTF-16', async () => {
    const settings = '<?xml version="1.0" encoding="UTF-16"?><w:settings xmlns:w="urn:w"/>'
    const attached = storeAttachment(
      'utf16.docx',
      zipSync({
        'word/document.xml': strToU8('<w:document xmlns:w="urn:w"><w:body/></w:document>'),
        'word/settings.xml': utf16(settings),
        'word/webSettings.xml': utf16(settings).swap16(),
      }),
    )

    const { files } = await okFiles(
      call(
        { listThreadFiles: async () => [attached] },
        replaceTextScript('utf16.docx', '<w:body/>', '<w:body><w:p/></w:body>'),
        ['utf16.docx'],
      ),
    )

    expect(files[0]).toMatchObject({ filename: 'utf16.docx', edited: true })
  })

  it('refuses XML that does not parse, in UTF-8 or UTF-16, or that is in neither', async () => {
    for (const xml of ['<a></b>', '<a/><b/>', '<x:a/>', '<a font="Ari"al"/>']) {
      expect(await checkErrorOf(zipWith(xml))).toContain('its part word/document.xml is not valid XML')
    }
    const brokenUtf16 = zipSync({ 'word/document.xml': utf16('<a></b>') })
    expect(await checkErrorOf(brokenUtf16)).toContain('its part word/document.xml is not valid XML')
    const notUtf8 = zipSync({ 'word/document.xml': new Uint8Array([0x3c, 0x61, 0xff, 0x2f, 0x3e]) })
    expect(await checkErrorOf(notUtf8)).toContain('its part word/document.xml is not valid XML')
  })

  it('refuses a part whose XML declaration names an encoding other than the one it is in', async () => {
    const declaringUtf8 = '<?xml version="1.0" encoding="UTF-8"?><a/>'
    for (const bytes of [utf16(declaringUtf8), utf16(declaringUtf8).swap16()]) {
      expect(await checkErrorOf(zipSync({ 'word/document.xml': bytes }))).toContain(
        'the XML declaration says encoding="UTF-8", but the part is UTF-16',
      )
    }
    expect(await checkErrorOf(zipWith(`<?xml version='1.0' encoding='utf-16'?><a/>`))).toContain(
      'the XML declaration says encoding="utf-16", but the part is UTF-8',
    )
  })

  it('refuses XML parts that claim more than the check can hold, without unzipping them', async () => {
    expect(await checkErrorOf(claimSize(zipWith('<a/>'), 300 * mib))).toBe(tooLargeToCheck)
  })

  it('refuses a small zip whose XML builds a tree too large for the check memory', async () => {
    const bomb = zipWith(`<a>${'<b/>'.repeat(250_000)}</a>`)
    expect(bomb.byteLength).toBeLessThan(2_000)

    // 16 MiB for the script gives the check 64 MiB, which the tree outgrows.
    expect(await checkErrorOf(bomb, { memoryBytes: 16 * mib })).toBe(tooLargeToCheck)
  })

  it('refuses an entry that claims to be empty, and stops decoding it at the script deadline', async () => {
    expect(await checkErrorOf(claimSize(zipWith('<a/>'), 0))).toContain('its part word/document.xml is not valid XML')

    const longStream = claimSize(zipWith(`<a>${' '.repeat(40 * mib)}</a>`), 0)
    expect(await checkErrorOf(longStream, { timeoutMs: 300 })).toBe(checkOutOfTime(0.3))
  })

  it('marks each saved file of a type the script read as edited, under any name', async () => {
    const attached = storeAttachment(`${'a'.repeat(300)}.DOCX`, await fixture('testComment.docx'))

    const { files } = await okFiles(
      call(
        { listThreadFiles: async () => [attached] },
        `saveFile('report_edited.docx', readFile(${JSON.stringify(attached.id)}))\n${pptxScript}`,
        [attached.id],
      ),
    )

    expect(files).toMatchObject([
      { filename: 'report_edited.docx', edited: true },
      { filename: 'deck.pptx', edited: false },
    ])
  })

  it('reads the newest edit by the name the user gave, though the edit is stored under a cleaned name', async () => {
    const threadFiles: ThreadFile[] = [storeAttachment('REPORT.DOCX', await fixture('testComment.docx'), 1000)]
    const edit = (from: string, to: string) =>
      okFiles(
        call({ listThreadFiles: async () => threadFiles }, replaceTextScript('REPORT.DOCX', from, to), ['REPORT.DOCX']),
      )

    const first = await edit('paragraph!', 'reviewed!')
    threadFiles.push({ ...stored(first.files[0].id), savedAs: first.files[0].savedAs })
    const second = await edit('reviewed!', 'final!')

    expect(first.files[0]).toMatchObject({ filename: 'REPORT.docx', savedAs: 'REPORT.DOCX' })
    expect(await textOf(stored(second.files[0].id))).toContain('this is a comment final!')
  })

  it('tells the script to declare a file it reads', async () => {
    expect(await errorOf(`readFile('report.docx')`)).toContain(
      '"report.docx" is not one of this run\'s inputs. Add it to inputs and call the tool again.',
    )
  })

  it('gives the script no network, no DOM and no app state', async () => {
    const { logs } = await runOk(`
      const names = ['fetch', 'XMLHttpRequest', 'WebSocket', 'document', 'window', 'navigator', 'indexedDB', 'localStorage', 'importScripts', 'postMessage']
      console.log(names.map((name) => typeof globalThis[name]).join(','))
      ${docxScript('probe.docx')}
    `)

    expect(logs).toBe(`${Array(10).fill('undefined').join(',')}\n`)
  })

  it('returns the script error with its line', async () => {
    expect(await errorOf('const a = 1\nthrow new Error("boom")')).toContain(
      'Error: boom\n    at <anonymous> (script.js:2',
    )
    expect(await errorOf('const x = ;')).toContain('SyntaxError')
  })

  it('stops a run at the time limit', async () => {
    expect(await errorOf('while (true) {}', { timeoutMs: 200 })).toContain('more than 0.2 seconds')
    expect(await errorOf('await Promise.resolve(); while (true) {}', { timeoutMs: 200 })).toContain(
      'more than 0.2 seconds',
    )
  })

  it('stops a run at 64 MiB of memory', async () => {
    expect(await errorOf('const chunks = []; for (;;) chunks.push(new Array(100000).fill(1))')).toContain(
      'more than 64 MiB of memory',
    )
  })

  it('counts the saved files against the memory limit', async () => {
    expect(
      await errorOf(
        'const big = new Uint8Array(8 * 1024 * 1024); for (let i = 0; i < 9; i++) saveFile(i + ".docx", big)',
      ),
    ).toContain('saved more than 64 MiB of files')
    // File names live outside the VM too.
    expect(
      await errorOf(
        'for (let i = 0; i < 17; i++) saveFile("x".repeat(4 * 1024 * 1024) + i + ".docx", new Uint8Array([1]))',
      ),
    ).toContain('saved more than 64 MiB of files')
  })

  it('stops a run at 4 MiB of text output', async () => {
    expect(await errorOf('const line = "x".repeat(65536); for (;;) console.log(line)')).toContain(
      'more than 4 MiB of text',
    )
  })

  it('returns only the start of a long console output or error', async () => {
    const { logs } = await runOk(`console.log("y".repeat(30000))\n${docxScript('long.docx')}`)

    expect(logs).toBe(`${'y'.repeat(20_000)}\n[The rest is not shown.]`)
    expect(await errorOf('throw new Error("z".repeat(5 * 1024 * 1024))')).toBe(
      `Error: ${'z'.repeat(20_000 - 'Error: '.length)}\n[The rest is not shown.]`,
    )
  })

  it('reports a script that waits on something the sandbox lacks', async () => {
    expect(await errorOf('await new Promise(() => {})')).toContain('never finished')
  })

  it('refuses a run that saves nothing, bytes of the wrong type, a name it cannot deliver, or one name twice', async () => {
    expect(await errorOf('console.log("no file")')).toContain('without saving a file')
    expect(await errorOf('saveFile("a.docx", "UEsDBBQ")')).toContain(
      'needs the bytes as a Uint8Array or an ArrayBuffer',
    )
    expect(await errorOf(`saveFile("notes.txt", ${emptyZip})`)).toContain('"notes.txt" is not a valid file name')
    expect(await errorOf(`saveFile("../x.docx", ${emptyZip})`)).toContain('is not a valid file name')
    expect(await errorOf(`saveFile(".docx", ${emptyZip})`)).toContain('is not a valid file name')
    expect(await errorOf(`saveFile("a.docx", ${emptyZip}); saveFile("a.docx", ${emptyZip})`)).toContain(
      '"a.docx" was saved twice',
    )
    expect(await errorOf(`saveFile("a:b.docx", ${emptyZip}); saveFile("a?b.docx", ${emptyZip})`)).toBe(
      '"a:b.docx" and "a?b.docx" both save as "a b.docx". Give each file its own name.',
    )
    expect(await errorOf(`saveFile("x".repeat(300) + ".docx", ${emptyZip})`)).toContain('is too long')
    expect(await errorOf('for (let i = 0; i < 21; i++) saveFile(i + ".docx", new Uint8Array([1]))')).toBe(
      'The script saved more than 20 files and was stopped. One run can save at most 20.',
    )
  })

  it('stops an endless loop of empty saves at the file limit, not at the time limit', async () => {
    expect(await errorOf("for (;;) saveFile('', new Uint8Array(0))")).toContain('saved more than 20 files')
  })

  it('keeps the file limit when a name converts to a string by saving more files', async () => {
    const name =
      '{ toString() { for (let i = 0; i < 20; i++) saveFile(i + ".docx", new Uint8Array([1])); return "outer.docx" } }'
    for (const save of ['saveFile', '__saveFile']) {
      expect(await errorOf(`${save}(${name}, new Uint8Array([1]))`)).toContain('saved more than 20 files')
    }
  })
})

describe('runSandboxedScript', () => {
  it('does not count loading the libraries against the script time', async () => {
    // A clock that moves one unit per reading, so the outcome depends on how much code runs, not on how fast
    // the machine is. Loading the libraries reads it about 200 times; this short script reads it almost never.
    let ticks = 0
    const clock = spyOn(performance, 'now').mockImplementation(() => ++ticks)
    let readyCalls = 0
    try {
      const result = await runSandboxedScript(
        { ...runtime, libraries: [...runtime.libraries, 'for (let i = 0; i < 1e6; i++) {}'] },
        { script: `saveFile("a.docx", ${emptyZip})`, inputs: [] },
        { ...sandboxLimits, timeoutMs: 10 },
        () => readyCalls++,
      )

      expect(result.ok).toBe(true)
      expect(readyCalls).toBe(1)
    } finally {
      clock.mockRestore()
    }
  })

  it('frees each copy readFile makes once the script drops it', async () => {
    // 16 reads of 8 MiB stay under the 64 MiB limit only if the dropped copies are freed.
    const input = { name: 'big.docx', bytes: new Uint8Array(8 * 1024 * 1024) }
    const result = await runSandboxedScript(runtime, {
      script: `for (let i = 0; i < 16; i++) readFile('big.docx')\nsaveFile('a.docx', ${emptyZip})`,
      inputs: [input],
    })

    expect(result).toMatchObject({ ok: true })
  })
})

describe('findBrokenFile', () => {
  it('says the check ran out of the script time, not that a valid file is too large', async () => {
    // QuickJS asks for an interrupt only every few thousand steps, so the part must be long enough to reach one.
    const files = [{ filename: 'a.docx', bytes: zipWith(`<a>${'<b/>'.repeat(10_000)}</a>`) }]

    expect(await findBrokenFile(runtime, files, sandboxLimits, performance.now() - 1)).toBe(checkOutOfTime(30))
  })
})
