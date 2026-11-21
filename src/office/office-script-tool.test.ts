/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { afterAll, describe, expect, it, mock, spyOn } from 'bun:test'
import { validateToolArguments } from '@earendil-works/pi-ai'
import { toPiAgentTools } from '@shared/agent-core/mcp-tools'
import { DOMParser } from '@xmldom/xmldom'
import type { JSONValue } from 'ai'
import { strToU8, zipSync } from 'fflate'
import JSZip from 'jszip'
import mammoth from 'mammoth'
import { docxMime, pptxMime } from '@/files/transformers'
import type { StoredFile } from '@/lib/file-blob-storage'
import { findBrokenFile } from './check-output'
import { type SandboxLimits, sandboxLimits } from './constants'
import {
  createOfficeScriptTool,
  type OfficeScriptInput,
  type OfficeScriptOutput,
  type OfficeScriptToolDeps,
} from './office-script-tool'
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

/** A script expression for the bytes of the Word input `reference` with a comment added, so the copy is a change. */
const editedCopy = (reference: string) =>
  `(() => { const parts = fflate.unzipSync(readFile(${JSON.stringify(reference)})); parts['word/document.xml'] = fflate.strToU8(fflate.strFromU8(parts['word/document.xml']) + '<!-- edited -->'); return fflate.zipSync(parts) })()`

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

describe('Office script retries', () => {
  const send = (deps: OfficeScriptToolDeps = {}) => {
    const tool = createOfficeScriptTool({ runScript: (job) => inProcess(job, sandboxLimits), storeFiles, ...deps })
    return (input: OfficeScriptInput): Promise<OfficeScriptOutput> => tool.execute(input)
  }
  const failedId = (output: OfficeScriptOutput) => {
    if (output.ok || !output.scriptId) {
      throw new Error('Expected retained failed script')
    }
    return output.scriptId
  }

  it('accepts omitted and null alternatives through Pi and requires both replacement fields', async () => {
    const { name, parameters } = createOfficeScriptTool()
    const [tool] = await toPiAgentTools({ [name]: { inputSchema: parameters } })
    const validate = (args: Record<string, JSONValue | undefined>) =>
      validateToolArguments(tool, { type: 'toolCall', id: 'test', name, arguments: structuredClone(args) })
    const edit = { scriptId: 'base', replacements: [{ find: 'line', replace: '' }] }
    for (const args of [{ edit }, { edit, script: null, inputs: null }, { script: 'x', edit: null, inputs: [] }]) {
      expect(validate(args)).toEqual(args)
    }
    for (const invalid of [
      { replacements: [] },
      { scriptId: 'x' },
      { ...edit, replacements: [{ find: 'x' }] },
      { ...edit, replacements: [{ replace: '' }] },
    ]) {
      expect(() => validate({ edit: invalid })).toThrow()
    }
  })

  it('applies edits atomically and literally, then lets only one racing retry save the DOCX', async () => {
    const runScript = mock((job: SandboxJob) => inProcess(job, sandboxLimits))
    const store = mock(storeFiles)
    const call = send({ runScript, storeFiles: store })
    const badLine = "throw Error('aaa')\r\n"
    const scriptId = failedId(await call({ script: badLine + docxScript('retry.docx'), edit: null }))
    for (const [find, matches] of [
      ['xyz', 0],
      ['aa', 2],
      ['Paragraph', 3],
      ['', 0],
    ] as const) {
      const result = await call({
        edit: {
          scriptId,
          replacements: [
            { find: 'Quarterly report', replace: 'changed' },
            { find, replace: '' },
          ],
        },
      })
      expect(result).toEqual({
        ok: false,
        error: expect.stringContaining(`Replacement 2: ${matches} matches`),
        logs: '',
      })
    }
    expect(runScript).toHaveBeenCalledTimes(1)
    expect(store).not.toHaveBeenCalled()
    const replacements = [
      { find: badLine, replace: '' },
      { find: 'Quarterly report', replace: 'intermediate title' },
      { find: 'intermediate title', replace: '$& $$ "report"' },
    ]
    const retry = { script: null, inputs: null, edit: { scriptId, replacements } }
    const [saved, expired] = await Promise.all([call(retry), call(retry)])
    if (!saved.ok) {
      throw new Error(saved.error)
    }
    expect(await textOf(stored(saved.files[0].id))).toContain('$& $$ "report"')
    expect(expired).toMatchObject({ ok: false, error: expect.stringContaining('send the full script') })
    expect(runScript).toHaveBeenCalledTimes(2)
    expect(store).toHaveBeenCalledTimes(1)
  })

  it('resolves inherited, replaced and cleared input lists again on each new version', async () => {
    const read = mock(async (path: string) => ({ status: 'read' as const, bytes: strToU8(path) }))
    const calls: SandboxJob[] = []
    const call = send({
      readWorkspaceFile: read,
      runScript: async (job) => {
        calls.push(job)
        return { ok: false, logs: 'log', error: job.script }
      },
    })
    const base = failedId(await call({ script: 'base', inputs: ['first'] }))
    const edit = { scriptId: base, replacements: [{ find: 'base', replace: 'next' }] }
    const changed = await call({ edit, inputs: null })
    expect(changed).toMatchObject({ error: 'next', logs: 'log' })
    const child = failedId(changed)
    expect(child).not.toBe(base)
    expect(await call({ edit })).toMatchObject({ error: expect.stringContaining('expired') })
    expect(await call({ edit: { scriptId: child, replacements: [] } })).toMatchObject({
      error: expect.stringContaining('at least one'),
    })
    const third = failedId(await call({ edit: { scriptId: child, replacements: [] }, inputs: ['other'] }))
    await call({ edit: { scriptId: third, replacements: [] }, inputs: [] })
    expect(read.mock.calls.map(([name]) => name)).toEqual(['first', 'first', 'other'])
    expect(calls.map((job) => job.inputs.map((input) => input.name))).toEqual([['first'], ['first'], ['other'], []])
  })

  it('evicts the oldest failure, isolates sends, and runs oversized full sources without retaining them', async () => {
    const runScript = mock(async ({ script }: SandboxJob) => ({
      ok: false as const,
      error: script.slice(0, 5),
      logs: '',
    }))
    const call = send({ runScript })
    const ids = []
    for (const script of ['first', 'other', 'third', 'fourth', 'fifth']) {
      ids.push(failedId(await call({ script })))
    }
    const edit = { scriptId: ids[1], replacements: [{ find: 'other', replace: 'sixth' }] }
    for (const result of [await send({ runScript })({ edit }), await call({ edit: { ...edit, scriptId: ids[0] } })]) {
      expect(result).toMatchObject({ error: expect.stringContaining('send the full script') })
    }
    for (const input of [{}, { edit: null, script: null }, { edit, script: 'both' }]) {
      expect(await call(input)).toMatchObject({ error: expect.stringContaining('exactly one') })
    }
    expect(runScript).toHaveBeenCalledTimes(5)
    expect(await call({ edit })).toMatchObject({ error: 'sixth', scriptId: expect.any(String) })
    expect(await call({ script: 'x'.repeat(128 * 1024 + 1) })).toEqual({
      ok: false,
      logs: '',
      error: expect.stringContaining('send the full script'),
    })
    expect(runScript).toHaveBeenCalledTimes(7)
  })

  it('checks the edit budget and each intermediate source before consuming the handle', async () => {
    const limit = 128 * 1024
    const call = send({ runScript: async () => ({ ok: false, error: 'failed', logs: '' }) })
    const scriptId = failedId(await call({ script: 'x' + 'y'.repeat(limit - 1) }))
    for (const replacements of [
      [
        { find: 'x', replace: 'xx' },
        { find: 'xx', replace: 'x' },
      ],
      [{ find: 'x', replace: 'y'.repeat(limit) }],
      Array.from({ length: 33 }, () => ({ find: 'x', replace: 'x' })),
    ]) {
      expect(await call({ edit: { scriptId, replacements } })).toMatchObject({
        error: expect.stringContaining('too large'),
      })
    }
    expect(await call({ edit: { scriptId, replacements: [] }, inputs: ['file'] })).toMatchObject({
      error: expect.stringContaining('too large'),
    })
    expect(failedId(await call({ edit: { scriptId, replacements: [] }, inputs: [] }))).not.toBe(scriptId)
  })
})

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

  it('patches a generated slide in memory before saving the deck once', async () => {
    const { files } = await runOk(`
      const pres = new PptxGenJS()
      pres.addSlide().addText('Draft')
      const bytes = await pres.write({ outputType: 'uint8array' })
      const parts = fflate.unzipSync(bytes)
      const path = 'ppt/slides/slide1.xml'
      const parse = (data) => new xmldom.DOMParser().parseFromString(fflate.strFromU8(data), 'application/xml')
      const slide = parse(parts[path])
      slide.getElementsByTagName('a:t')[0].textContent = 'Final title'
      parts[path] = fflate.strToU8(new xmldom.XMLSerializer().serializeToString(slide))
      const zipped = fflate.zipSync(parts)
      if (parse(fflate.unzipSync(zipped)[path]).getElementsByTagName('a:t')[0].textContent !== 'Final title') {
        throw new Error('Slide title did not change')
      }
      saveFile('deck.pptx', zipped)
    `)

    expect(files).toHaveLength(1)
    expect(await partOf(stored(files[0].id), 'ppt/slides/slide1.xml')).toContain('<a:t>Final title</a:t>')
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
        saveFile('summary.docx', ${editedCopy('notes.docx')})
        `,
        ['notes.docx', older.id],
      ),
    )

    expect(logs).toBe('true true\n')
    expect(files[0]).toMatchObject({ filename: 'summary.docx', edited: false })
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
      error: `No file "data/sales.json" in this chat. The files in this chat, newest first: "brief.docx" (id ${attached.id}). Name an input by its file name or its id. If the user named this file, tell them it is not here and ask which file they mean; do not edit another file in its place.`,
      scriptId: expect.any(String),
      retry: expect.stringContaining('call again with edit'),
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

  it('saves an edit to an attached file whose untouched part declares windows-1252, leaving that part as it was', async () => {
    // "Café" in windows-1252, where é is the single byte 0xE9.
    const app = new Uint8Array([
      ...strToU8('<?xml version="1.0" encoding="windows-1252"?><Properties><Company>Caf'),
      0xe9,
      ...strToU8('</Company></Properties>'),
    ])
    const attached = storeAttachment(
      'legacy.docx',
      zipSync({
        'word/document.xml': strToU8('<w:document xmlns:w="urn:w"><w:body/></w:document>'),
        'docProps/app.xml': app,
      }),
    )

    const { files } = await okFiles(
      call(
        { listThreadFiles: async () => [attached] },
        replaceTextScript('legacy.docx', '<w:body/>', '<w:body><w:p/></w:body>'),
        ['legacy.docx'],
      ),
    )

    const saved = await zipOf(stored(files[0].id))
    expect(await saved.file('docProps/app.xml')?.async('uint8array')).toEqual(app)
    expect(await checkErrorOf(zipWith('<?xml version="1.0" encoding="windows-1252"?><a></b>'))).toContain(
      'its part word/document.xml is not valid XML',
    )
  })

  it('refuses a DDE field or link, even split across runs or in a simple field', async () => {
    const run = (text: string) => `<w:r><w:instrText xml:space="preserve">${text}</w:instrText></w:r>`
    const mark = (type: string) => `<w:r><w:fldChar w:fldCharType="${type}"/></w:r>`
    const field = (...codes: string[]) => `${mark('begin')}${codes.map(run).join('')}${mark('separate')}${mark('end')}`
    const documents = [
      `<w:document xmlns:w="urn:w"><w:body><w:p>${run(' DD')}${run('EAUTO c:\\\\windows\\\\system32\\\\cmd.exe ')}</w:p></w:body></w:document>`,
      `<w:document xmlns:w="urn:w"><w:body><w:p>${field(' DD', 'EAUTO cmd ')}</w:p></w:body></w:document>`,
      `<w:document xmlns:w="urn:w"><w:body><w:p>${field('PAGE')}${field('DDEAUTO cmd')}</w:p></w:body></w:document>`,
      '<w:document xmlns:w="urn:w"><w:body><w:p><w:fldSimple w:instr="DDE &quot;calc&quot; x"/></w:p></w:body></w:document>',
    ]
    for (const xml of documents) {
      expect(await checkErrorOf(zipWith(xml))).toStartWith(
        '"a.docx" has a DDE field in word/document.xml, which can run a program when the file opens',
      )
    }
    const ddeLink = zipSync({
      '[Content_Types].xml': strToU8('<Types/>'),
      'xl/externalLinks/externalLink1.xml': strToU8(
        '<externalLink xmlns="urn:x"><ddeLink ddeService="cmd" ddeTopic="/c calc"/></externalLink>',
      ),
    })
    expect(await checkErrorOf(ddeLink)).toStartWith('"a.docx" has a DDE field in xl/externalLinks/externalLink1.xml')

    // Office reads a part as XML by its declared content type, whatever its name says.
    const typed = (types: string, parts: Record<string, string>, typesName = '[Content_Types].xml') =>
      zipSync({
        [typesName]: strToU8(
          `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">${types}</Types>`,
        ),
        '_rels/.rels': strToU8(
          '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.dat"/></Relationships>',
        ),
        ...Object.fromEntries(Object.entries(parts).map(([name, xml]) => [name, strToU8(xml)])),
      })
    const mainType = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml'
    const ddeDocument =
      '<w:document xmlns:w="urn:w"><w:body><w:p><w:fldSimple w:instr="DDEAUTO cmd"/></w:p></w:body></w:document>'
    for (const types of [
      `<Override PartName="/word/document.dat" ContentType="${mainType}"/>`,
      `<Default Extension="DAT" ContentType="${mainType}"/>`,
    ]) {
      expect(await checkErrorOf(typed(types, { 'word/document.dat': ddeDocument }))).toStartWith(
        '"a.docx" has a DDE field in word/document.dat',
      )
    }
    // OPC part names ignore case, so the content types still count under another capitalization.
    const upperTypes = typed(
      `<Override PartName="/word/document.dat" ContentType="${mainType}"/>`,
      { 'word/document.dat': ddeDocument },
      '[CONTENT_TYPES].XML',
    )
    expect(await checkErrorOf(upperTypes)).toStartWith('"a.docx" has a DDE field in word/document.dat')
    const externalLink = typed(
      '<Override PartName="/xl/externalLinks/externalLink1.bin" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.externalLink+xml"/>',
      {
        'xl/externalLinks/externalLink1.bin':
          '<externalLink xmlns="urn:x"><ddeLink ddeService="cmd" ddeTopic="/c calc"/></externalLink>',
      },
    )
    expect(await checkErrorOf(externalLink)).toStartWith(
      '"a.docx" has a DDE field in xl/externalLinks/externalLink1.bin',
    )
    const broken = typed('<Default Extension="bin" ContentType="application/xml"/>', { 'word/custom.bin': '<a></b>' })
    expect(await checkErrorOf(broken)).toStartWith(
      '"a.docx" would not open: its part word/custom.bin is not valid XML (',
    )
    // A picture typed image/svg+xml is not parsed: a valid SVG may declare entities the strict parser refuses.
    const renamed = typed(
      `<Override PartName="/word/document.dat" ContentType="${mainType}"/><Default Extension="svg" ContentType="image/svg+xml"/>`,
      {
        'word/document.dat':
          '<w:document xmlns:w="urn:w"><w:body><w:p><w:fldSimple w:instr="PAGE"/></w:p></w:body></w:document>',
        'word/media/image1.svg':
          '<!DOCTYPE svg [<!ENTITY ns "http://www.w3.org/2000/svg">]><svg xmlns="&ns;"><rect width="1" height="1"/></svg>',
      },
    )
    const harmless = `saveFile('a.docx', new Uint8Array([${renamed.join(',')}]))`
    expect((await okFiles(call({}, harmless))).files).toHaveLength(1)

    const ordinary = `<w:document xmlns:w="urn:w"><w:body><w:p>${run(' PAGE ')}${field(' HYPERLINK "https://example.com/DDE" ')}<w:fldSimple w:instr="PAGE"/></w:p></w:body></w:document>`
    const page = storeAttachment('page.docx', zipWith(ordinary))
    const script = `saveFile('page.docx', ${editedCopy('page.docx')})`
    expect((await okFiles(call({ listThreadFiles: async () => [page] }, script, ['page.docx']))).files).toHaveLength(1)
  })

  it('refuses a file saved without any change, however it was zipped again', async () => {
    const attached = storeAttachment('memo.docx', zipWith('<w:document xmlns:w="urn:w"/>'))
    const script = `saveFile('memo.docx', fflate.zipSync(fflate.unzipSync(readFile('memo.docx')), { level: 0 }))`

    const result = await call({ listThreadFiles: async () => [attached] }, script, ['memo.docx'])

    expect(result).toMatchObject({
      ok: false,
      error:
        '"memo.docx" is the same as a file this run read: the edit changed nothing, so it was not saved. Make the change the user asked for, or tell the user that nothing changed.',
    })
  })

  it('refuses a remote template, an external link or an OLE object the script added, but keeps the ones the file had', async () => {
    const relationships = (type: string, external: boolean) =>
      `<Relationships xmlns="urn:r"><Relationship Id="r1" Type="urn:t/${type}" Target="https://example.com/x"${external ? ' TargetMode="External"' : ''}/></Relationships>`
    const withRelationship = (type: string, external: boolean, text = '') =>
      zipSync({
        '[Content_Types].xml': strToU8('<Types/>'),
        'word/document.xml': strToU8(`<w:document xmlns:w="urn:w">${text}</w:document>`),
        'word/_rels/settings.xml.rels': strToU8(relationships(type, external)),
      })
    const plain = storeAttachment('plain.docx', zipWith('<w:document xmlns:w="urn:w"/>'))
    const added = [
      ['attachedTemplate', true, 'a template linked from outside the file'],
      ['image', true, 'a link to content outside the file'],
      ['oleObject', false, 'an OLE object'],
    ] as const
    for (const [type, external, what] of added) {
      const bytes = withRelationship(type, external)
      const script = `readFile('plain.docx'); saveFile('a.docx', new Uint8Array([${bytes.join(',')}]))`
      const result = await call({ listThreadFiles: async () => [plain] }, script, ['plain.docx'])
      expect(result.ok ? '' : result.error).toStartWith(`"a.docx" was not saved: the script added ${what}, which`)
    }

    const hyperlink = withRelationship('hyperlink', true)
    const linked = `saveFile('a.docx', new Uint8Array([${hyperlink.join(',')}]))`
    expect((await okFiles(call({}, linked))).files).toHaveLength(1)

    const template = storeAttachment('template.docx', withRelationship('attachedTemplate', true))
    const script = `saveFile('template.docx', ${editedCopy('template.docx')})`
    expect(
      (await okFiles(call({ listThreadFiles: async () => [template] }, script, ['template.docx']))).files,
    ).toHaveLength(1)
  })

  it('refuses a Word field that fills itself from outside the file, unless the edited file had it', async () => {
    const run = (text: string) => `<w:r><w:instrText xml:space="preserve">${text}</w:instrText></w:r>`
    const mark = (type: string) => `<w:r><w:fldChar w:fldCharType="${type}"/></w:r>`
    const field = (...codes: string[]) => `${mark('begin')}${codes.map(run).join('')}${mark('separate')}${mark('end')}`
    const document = (body: string) => `<w:document xmlns:w="urn:w"><w:body><w:p>${body}</w:p></w:body></w:document>`
    const picture = field(' INCLUDEPICTURE "https://example.com/a.png" \\* MERGEFORMATINET ')
    for (const body of [
      picture,
      field(' INCLUDE', 'PICTURE "https://example.com/a.png" \\d '),
      '<w:fldSimple w:instr="INCLUDETEXT &quot;\\\\host\\share\\a.docx&quot;"/>',
      field(' IMPORT \\\\host\\share\\a.png '),
      field(' LINK Excel.Sheet.8 "\\\\host\\share\\a.xlsx" "Sheet1!R1C1" \\a '),
      // Word runs { {QUOTE 68 68 69} ... } as a DDE field.
      `${mark('begin')}${field(' QUOTE 68 68 69 ')}${run(' "c:\\\\windows\\\\system32\\\\cmd.exe" ')}${mark('separate')}${mark('end')}`,
    ]) {
      const result = await call({}, `saveFile('a.docx', new Uint8Array([${zipWith(document(body)).join(',')}]))`)
      expect(result.ok ? '' : result.error).toStartWith(
        '"a.docx" was not saved: the script added a field that loads content from outside the file, or whose name another field computes, which Word acts on when the file opens, in word/document.xml',
      )
    }

    const pictures = storeAttachment('pictures.docx', zipWith(document(picture)))
    const deps = { listThreadFiles: async () => [pictures] }
    const kept = `saveFile('pictures.docx', ${editedCopy('pictures.docx')})`
    expect((await okFiles(call(deps, kept, ['pictures.docx']))).files).toHaveLength(1)
    const retargeted = `
const parts = fflate.unzipSync(readFile('pictures.docx'))
parts['word/document.xml'] = fflate.strToU8(fflate.strFromU8(parts['word/document.xml']).replace('example.com', 'example.org'))
saveFile('pictures.docx', fflate.zipSync(parts))
`
    const result = await call(deps, retargeted, ['pictures.docx'])
    expect(result.ok ? '' : result.error).toStartWith('"pictures.docx" was not saved: the script added a field')

    // A part that is XML only by its content type keeps its fields too.
    const mainType = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml'
    const renamed = storeAttachment(
      'renamed.docx',
      zipSync({
        '[Content_Types].xml': strToU8(
          `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/word/document.dat" ContentType="${mainType}"/></Types>`,
        ),
        'word/document.dat': strToU8(document(picture)),
      }),
    )
    const edit = `
const parts = fflate.unzipSync(readFile('renamed.docx'))
parts['word/document.dat'] = fflate.strToU8(fflate.strFromU8(parts['word/document.dat']) + '<!-- edited -->')
saveFile('renamed.docx', fflate.zipSync(parts))
`
    const renamedDeps = { listThreadFiles: async () => [renamed] }
    expect((await okFiles(call(renamedDeps, edit, ['renamed.docx']))).files).toHaveLength(1)
  })

  it('refuses a part name that is not a plain path inside the zip', async () => {
    for (const name of ['../../evil.xml', '/abs.bin', 'C:\\evil.bin', 'word/./a.bin', 'word//a.bin']) {
      const bytes = zipSync({ '[Content_Types].xml': strToU8('<Types/>'), [name]: new Uint8Array([1]) })
      expect(await checkErrorOf(bytes)).toStartWith(`"a.docx" has a part named ${JSON.stringify(name)}`)
    }
  })

  it('refuses a file whose parts unzip past the limit, binary parts included, without unzipping them', async () => {
    const bytes = zipSync({ '[Content_Types].xml': strToU8('<Types/>'), 'word/media/blob.bin': new Uint8Array(16) })
    expect(await checkErrorOf(claimSize(bytes, sandboxLimits.unzipBytes + 1))).toBe(
      `"a.docx" unzips to more than ${sandboxLimits.unzipBytes / mib} MiB, the most a saved file may hold. Make it smaller, for example with smaller images, then call the tool again.`,
    )
  })

  it('refuses a binary part that unzips to more than it claims', async () => {
    const bytes = zipSync({ '[Content_Types].xml': strToU8('<Types/>'), 'word/media/blob.bin': new Uint8Array(mib) })
    expect(await checkErrorOf(claimSize(bytes, 16))).toStartWith(
      '"a.docx" does not open as a zip (A part of the zip unpacks to more than it declares)',
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

  it('marks as edited only a saved file that keeps the name of a file the script read', async () => {
    const attached = storeAttachment('REPORT.DOCX', await fixture('testComment.docx'))
    const long = storeAttachment(`${'a'.repeat(300)}.docx`, await fixture('testComment.docx'))

    const { files } = await okFiles(
      call(
        { listThreadFiles: async () => [attached, long] },
        `
        saveFile('REPORT.DOCX', ${editedCopy('REPORT.DOCX')})
        saveFile('report_edited.docx', ${editedCopy('REPORT.DOCX')})
        saveFile('summary.docx', ${editedCopy(long.id)})
        ${pptxScript}`,
        ['REPORT.DOCX', long.id],
      ),
    )

    expect(files).toMatchObject([
      { filename: 'REPORT.docx', edited: true },
      { filename: 'report_edited.docx', edited: false },
      { filename: 'summary.docx', edited: false },
      { filename: 'deck.pptx', edited: false },
    ])
  })

  it('notes each new file whose type matches a file the run read', async () => {
    const attached = storeAttachment('template.docx', await fixture('testComment.docx'))

    const output = await okFiles(
      call(
        { listThreadFiles: async () => [attached] },
        `
        saveFile('template.docx', ${editedCopy('template.docx')})
        saveFile('budget-2027.docx', ${editedCopy('template.docx')})
        ${pptxScript}`,
        ['template.docx', attached.id],
      ),
    )

    expect(output.files.map(({ filename, edited }) => [filename, edited])).toEqual([
      ['template.docx', true],
      ['budget-2027.docx', false],
      ['deck.pptx', false],
    ])
    expect(output.notes).toEqual([
      '"budget-2027.docx" is a new file made from "template.docx", not an edit of a file with that name. If the user asked you to edit "budget-2027.docx", list that exact name in `inputs`: the tool then reads that file or says it does not exist. Do not present this file as the edited one.',
    ])
    expect((await runOk(docxScript('report.docx'))).notes).toBeUndefined()
  })

  it('does not call a file missing when the chat has it but the run did not read it', async () => {
    const template = storeAttachment('template.docx', await fixture('testComment.docx'))
    const report = storeAttachment('report.docx', await fixture('testComment.docx'))

    const output = await okFiles(
      call(
        { listThreadFiles: async () => [template, report] },
        `saveFile('report.docx', ${editedCopy('template.docx')})`,
        ['template.docx'],
      ),
    )

    expect(output.notes).toEqual([
      '"report.docx" is a new file made from "template.docx", not an edit of a file with that name. If the user asked you to edit "report.docx", list that exact name in `inputs`: the tool then reads that file or says it does not exist. Do not present this file as the edited one.',
    ])
  })

  it('refuses files that would take the ones it made in this chat past the limit, saving none', async () => {
    const before = attachmentStore.size
    const earlier: ThreadFile = {
      ...storeAttachment('big.docx', zipWith('<a/>')),
      size: sandboxLimits.threadFileBytes - 10,
      savedAs: 'big.docx',
    }

    const result = await call({ listThreadFiles: async () => [earlier, earlier] }, docxScript('more.docx'))

    expect(result).toMatchObject({
      ok: false,
      error: expect.stringContaining(`past the ${sandboxLimits.threadFileBytes / mib} MiB one chat may hold`),
    })
    expect(attachmentStore.size).toBe(before + 1)
    // An attachment of the user's own does not count.
    const attachment = { ...earlier, savedAs: undefined }
    expect((await call({ listThreadFiles: async () => [attachment] }, docxScript('more.docx'))).ok).toBe(true)
  })

  it('counts the files of a call still being stored against the limit of a call made at the same time', async () => {
    const earlier: ThreadFile = {
      ...storeAttachment('big.docx', zipWith('<a/>')),
      size: sandboxLimits.threadFileBytes - 30,
      savedAs: 'big.docx',
    }
    // Each call saves a 22-byte zip: one fits, two do not. Storing waits until both scripts have finished.
    let finishedRuns = 0
    const concurrent = createOfficeScriptTool({
      runScript: async (job) => {
        const result = await runner(job, sandboxLimits)
        finishedRuns++
        return result
      },
      storeFiles: async (files) => {
        while (finishedRuns < 2) {
          await Bun.sleep(1)
        }
        await storeFiles(files)
      },
      listThreadFiles: async () => [earlier],
    })
    const save = () => concurrent.execute({ script: `saveFile('a.docx', ${emptyZip})` }) as Promise<OfficeScriptOutput>

    const results = await Promise.all([save(), save()])

    expect(results.map(({ ok }) => ok).sort()).toEqual([false, true])
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

  it('says the libraries are globals when a script tries to import one', async () => {
    const error = await errorOf("const excelizeWasm = await import('excelize-wasm')")
    expect(error).toContain("could not load module 'excelize-wasm'")
    expect(error).toContain('are already globals')
  })

  it('shows the script line an error points at, with a caret under its column', async () => {
    const misplaced = 'const b = [new docx.Paragraph("x", bold: true)]'
    expect(await errorOf(`const a = 1\n${misplaced}`)).toEndWith(
      `Line 2 of the script:\n${misplaced}\n${' '.repeat(misplaced.indexOf(':'))}^`,
    )
    // The first line shares the wrapper's line, whose characters QuickJS counts.
    expect(await errorOf('const x = foo(: 1)')).toEndWith(
      `Line 1 of the script:\nconst x = foo(: 1)\n${' '.repeat(14)}^`,
    )
    expect(await errorOf('const a = 1\n  null.x')).toEndWith('Line 2 of the script:\n  null.x\n  ^')
    const long = `const s = "${'x'.repeat(400)}"; const y = (: 1)`
    expect(await errorOf(long)).toEndWith(
      `${long.slice(long.length - 160)}\n${' '.repeat(160 - (long.length - long.indexOf('(:') - 1))}^`,
    )
    // A thrown string can claim any column; the caret stops at the end of the real line.
    const forged = 'throw "script.js:1:200000000"'
    expect(await errorOf(forged)).toEndWith(`Line 1 of the script:\n${forged}\n${' '.repeat(forged.length)}^`)
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

  it('returns the logs of a run that saves nothing and stores nothing', async () => {
    const store = mock(storeFiles)

    expect(await tool({ storeFiles: store }).execute({ script: 'console.log("probe")' })).toEqual({
      ok: true,
      files: [],
      logs: 'probe\n',
      notes: ['No file was saved, so the user sees nothing from this run.'],
    })
    expect(store).not.toHaveBeenCalled()
  })

  it('refuses bytes of the wrong type, a name it cannot deliver, or one name twice', async () => {
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

describe('Office script tool description', () => {
  const workspace: ReadWorkspaceFile = async () => ({ status: 'missing' })

  it('stays short, since every request sends it', () => {
    expect(createOfficeScriptTool().description.length).toBeLessThan(1_950)
    expect(createOfficeScriptTool({ readWorkspaceFile: workspace }).description.length).toBeLessThan(1_950)
  })

  it('tells the model to load the Office skills only when it has some', () => {
    const load = 'Before writing or editing a script, load the listed Office skill'
    expect(createOfficeScriptTool().description).not.toContain(load)
    expect(createOfficeScriptTool({ skills: [] }).description).not.toContain(load)
    expect(createOfficeScriptTool({ skills: ['office-docx', 'office-xlsx'] }).description).toContain(
      'unless its instructions are already in context: office-docx, office-xlsx.',
    )
  })
})

describe('Office script failure hints', () => {
  const pointer = 'Before you fix this, load the Office skill for this format'
  const conditionalFormat = `const f = excelize.NewFile()
f.SetConditionalFormat("Sheet1", "A1:A2", [{ Type: "expression", Criteria: "$A1>1", Format: 0 }])`
  const failing =
    (error: string): OfficeScriptToolDeps['runScript'] =>
    async () => ({ ok: false, error, logs: 'log' })
  const errorOf = async (output: Promise<OfficeScriptOutput>) => {
    const result = await output
    if (result.ok) {
      throw new Error('Expected a failed run')
    }
    return result
  }

  it('points the first failure of a send to the visible skill for its format, and only the first', async () => {
    const tool = createOfficeScriptTool({
      runScript: (job) => inProcess(job, sandboxLimits),
      storeFiles,
      skills: ['office-xlsx', 'office-docx'],
    })

    const first = await errorOf(tool.execute({ script: conditionalFormat }))
    expect(first.error).toStartWith('Error: SetConditionalFormat: ')
    expect(first.error).toEndWith(`${pointer} unless its instructions are already in context: office-xlsx.`)
    expect(first.scriptId).toBeString()
    expect(first.retry).toContain(first.scriptId!)

    const second = await errorOf(tool.execute({ script: conditionalFormat }))
    expect(second.error).not.toContain(pointer)
    expect(second.error).not.toContain('SetConditionalFormat takes')
    expect(second.scriptId).toBeString()
  })

  it('reads the format from the script when the error names none', async () => {
    const tool = createOfficeScriptTool({
      runScript: failing('TypeError: cannot read property of undefined'),
      skills: ['office-docx', 'office-pptx'],
    })
    const { error } = await errorOf(tool.execute({ script: 'const pres = new PptxGenJS()\npres.addSlide().x.y = 1' }))
    expect(error).toEndWith(': office-pptx.')
  })

  it('gives how to call the failing Excelize method when the Excel skill is not offered', async () => {
    const hints = {
      'Error: SetConditionalFormat: parameter is invalid': 'SetConditionalFormat takes an array of rules',
      'Error: AddChart: invalid argument data type: argument 3.Type is a string, where Excelize takes a number':
        'Type: excelize.Col',
      'Error: SetCellValue: invalid arguments in call': 'Cells are A1 names',
      'Error: NewConditionalStyle: invalid argument data type': 'separate sequence that starts at 0',
      'Error: SetColWidth: invalid argument data type: the arguments are a string, a number, a number, a number':
        'f.SetColWidth("Sheet1", "A", "F", 15)',
    }
    for (const [message, hint] of Object.entries(hints)) {
      const tool = createOfficeScriptTool({ runScript: failing(message), skills: ['office-docx'] })
      const { error } = await errorOf(tool.execute({ script: 'const f = excelize.NewFile()' }))
      expect(error).toStartWith(message)
      expect(error).toContain(hint)
      expect(error).not.toContain(pointer)
    }
  })

  it('adds nothing when neither a skill nor a known method applies', async () => {
    const unknown = 'Error: GetRows: sheet Budget does not exist'
    const tool = createOfficeScriptTool({ runScript: failing(unknown) })
    expect((await errorOf(tool.execute({ script: 'const f = excelize.NewFile()' }))).error).toBe(unknown)
  })

  it('adds nothing to an error that tells the model to stop', async () => {
    const tooLarge = `Error: This workbook is larger than the ${sandboxLimits.maxWorkbookBytes / 1024 / 1024} MiB excelize can open here. Stop and tell the user it is too large to edit here; do not rebuild or unzip it.`
    const tool = createOfficeScriptTool({ runScript: failing(tooLarge), skills: ['office-xlsx'] })
    expect((await errorOf(tool.execute({ script: 'excelize.OpenReader(new Uint8Array(1))' }))).error).toBe(tooLarge)
  })

  it('keeps the missing-file guidance as it was and still hints the next script failure', async () => {
    const tool = createOfficeScriptTool({
      runScript: failing('Error: SetConditionalFormat: parameter is invalid'),
      skills: ['office-xlsx'],
    })
    const missing = await errorOf(tool.execute({ script: 'readFile("budget.xlsx")', inputs: ['budget.xlsx'] }))
    expect(missing.error).not.toContain(pointer)
    expect(missing.error).toContain('budget.xlsx')

    const failed = await errorOf(tool.execute({ script: 'const f = excelize.NewFile()' }))
    expect(failed.error).toContain(`${pointer} unless its instructions are already in context: office-xlsx.`)
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
