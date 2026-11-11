/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { afterAll, describe, expect, it } from 'bun:test'
import JSZip from 'jszip'
import mammoth from 'mammoth'
import { docxMime, pptxMime } from '@/files/transformers'
import type { StoredFile } from '@/lib/file-blob-storage'
import { type SandboxLimits, sandboxLimits } from './constants'
import { createOfficeScriptTool, type OfficeScriptOutput } from './office-script-tool'
import { runSandboxedScript, type SandboxResult } from './sandbox'
import { loadTestSandboxRuntime } from './sandbox-test-runtime'

type Runner = (script: string, limits: SandboxLimits) => Promise<SandboxResult>

const runtime = await loadTestSandboxRuntime()

const inProcess: Runner = (script, limits) => runSandboxedScript(runtime, script, limits)

/*
 * The same runs in a Bun Worker without `Symbol.dispose`, standing in for system WebKit. One run at a time,
 * so a run that blocks the Worker can't eat into the next one's time limit.
 */
const worker = new Worker(new URL('./no-symbol-dispose.test-worker.ts', import.meta.url))
const workerReady = new Promise<void>((resolve) => {
  worker.onmessage = () => resolve()
})
let queue: Promise<unknown> = workerReady
const withoutSymbolDispose: Runner = (script, limits) => {
  const run = queue.then(
    () =>
      new Promise<SandboxResult>((resolve) => {
        worker.onmessage = ({ data }: MessageEvent<SandboxResult>) => resolve(data)
        worker.postMessage({ script, limits })
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

// Stands in for the IndexedDB attachment store, whose Blob values don't survive fake-indexeddb under happy-dom.
const attachmentStore = new Map<string, StoredFile>()
const storeFile = async (file: StoredFile) => {
  attachmentStore.set(file.id, file)
}

const stored = (id: string): StoredFile => {
  const file = attachmentStore.get(id)
  expect(file).toBeDefined()
  return file!
}

describe.each([
  ['with Symbol.dispose', inProcess],
  ['without Symbol.dispose', withoutSymbolDispose],
] as const)('run_office_script %s', (_, runner) => {
  const run = (script: string, limits: Partial<SandboxLimits> = {}) =>
    createOfficeScriptTool((source) => runner(source, { ...sandboxLimits, ...limits }), storeFile).execute({
      script,
    }) as Promise<OfficeScriptOutput>

  const runOk = async (script: string) => {
    const result = await run(script)
    if (!result.ok) {
      throw new Error(result.error)
    }
    return result
  }

  const errorOf = async (script: string, limits?: Partial<SandboxLimits>) => {
    const result = await run(script, limits)
    expect(result.ok).toBe(false)
    return result.ok ? '' : result.error
  }

  it('saves a DOCX that a second reader opens', async () => {
    const { files } = await runOk(docxScript('report.docx'))

    expect(files).toEqual([{ id: expect.any(String), filename: 'report.docx', mimeType: docxMime }])
    const file = stored(files[0].id)
    expect(file).toMatchObject({ filename: 'report.docx', mimeType: docxMime })
    expect(file.size).toBeGreaterThan(0)
    // Bun resolves mammoth's Node build, which reads a Buffer.
    const { value: text } = await mammoth.extractRawText({ buffer: Buffer.from(await file.blob.arrayBuffer()) })
    expect(text).toContain('Quarterly report')
    expect(text).toContain('Revenue up 12%')
  })

  it('saves a PPTX whose slide and chart parts unzip', async () => {
    const { files } = await runOk(pptxScript)

    expect(files).toEqual([{ id: expect.any(String), filename: 'deck.pptx', mimeType: pptxMime }])
    const zip = await JSZip.loadAsync(await stored(files[0].id).blob.arrayBuffer())
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
        'for (let i = 0; i < 80; i++) saveFile("x".repeat(1024 * 1024) + i + ".docx", new Uint8Array([1]))',
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
    expect(await errorOf('saveFile("notes.txt", new Uint8Array([1]))')).toContain(
      '"notes.txt" is not a valid file name',
    )
    expect(await errorOf('saveFile("../x.docx", new Uint8Array([1]))')).toContain('is not a valid file name')
    expect(await errorOf('saveFile(".docx", new Uint8Array([1]))')).toContain('is not a valid file name')
    expect(await errorOf('saveFile("a.docx", new Uint8Array([1])); saveFile("a.docx", new Uint8Array([2]))')).toContain(
      '"a.docx" was saved twice',
    )
    expect(await errorOf('saveFile("x".repeat(300) + ".docx", new Uint8Array([1]))')).toContain('is too long')
    expect(await errorOf('for (let i = 0; i < 21; i++) saveFile(i + ".docx", new Uint8Array([1]))')).toContain(
      'at most 20',
    )
  })
})
