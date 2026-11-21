/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'bun:test'
import { DOMParser, type Element } from '@xmldom/xmldom'
import { strFromU8, unzipSync } from 'fflate'
import type { StoredFile } from '@/lib/file-blob-storage'
import { sandboxLimits } from './constants'
import { createOfficeScriptTool, type OfficeScriptOutput } from './office-script-tool'
import { runSandboxedScript } from './sandbox'
import { loadTestSandboxRuntime } from './sandbox-test-runtime'
import { officeDocxSkill } from './skills/docx'
import { officePptxSkill } from './skills/pptx'
import { officeXlsxSkill } from './skills/xlsx'

const runtime = await loadTestSandboxRuntime()

type Parts = Record<string, Uint8Array>
type Saved = {
  output: Extract<OfficeScriptOutput, { ok: true }>
  bytes: Attachments
  files: Record<string, Parts>
}
type Attachments = Record<string, Uint8Array<ArrayBuffer>>

/** A skill example, found by a snippet only it contains, with the files it reads and what its saved files must hold. */
type Example = {
  name: string
  match: string
  attachments?: () => Promise<Attachments>
  check: (saved: Saved) => void | Promise<void>
}

const fixture = async (name: string) =>
  new Uint8Array(await Bun.file(new URL(`./test-fixtures/${name}`, import.meta.url)).arrayBuffer())

const png = async () => new Uint8Array(unzipSync(await fixture('testComment.docx'))['word/media/image1.png'])

/**
 * Run a script through the tool as a model would, with `attachments` as the chat's files and all of them listed in
 * `inputs`. Fails on an error result; otherwise returns the saved files, raw and unzipped.
 */
const run = async (script: string, attachments: Attachments = {}): Promise<Saved> => {
  const store = new Map<string, StoredFile>()
  for (const [filename, bytes] of Object.entries(attachments)) {
    const id = crypto.randomUUID()
    store.set(id, {
      id,
      filename,
      mimeType: '',
      size: bytes.byteLength,
      createdAt: Date.now(),
      blob: new Blob([bytes]),
    })
  }
  const tool = createOfficeScriptTool({
    runScript: (job) => runSandboxedScript(runtime, job),
    storeFiles: async (files) => files.forEach((file) => store.set(file.id, file)),
    listThreadFiles: async () => [...store.values()],
  })
  const output = (await tool.execute({ script, inputs: Object.keys(attachments) })) as OfficeScriptOutput
  if (!output.ok) {
    throw new Error(`${output.error}\n${output.logs}`)
  }
  const bytes = Object.fromEntries(
    await Promise.all(
      output.files.map(
        async ({ id, filename }): Promise<[string, Uint8Array<ArrayBuffer>]> => [
          filename,
          new Uint8Array(await store.get(id)!.blob.arrayBuffer()),
        ],
      ),
    ),
  )
  const files = Object.fromEntries(Object.entries(bytes).map(([filename, file]) => [filename, unzipSync(file)]))
  return { output, bytes, files }
}

const parser = new DOMParser()
const xml = (parts: Parts, name: string) => parser.parseFromString(strFromU8(parts[name]), 'application/xml')
const all = (node: { getElementsByTagNameNS: Element['getElementsByTagNameNS'] }, localName: string) =>
  Array.from(node.getElementsByTagNameNS('*', localName))
const text = (node: Element) =>
  all(node, 't')
    .map((t) => t.textContent)
    .join('')

/** Each paragraph's text in a Word part. */
const paragraphs = (parts: Parts, name = 'word/document.xml') => all(xml(parts, name), 'p').map(text)

/** The cell `ref` of a worksheet, with its formula, cached value and style index. */
const cell = (parts: Parts, ref: string, sheet = 'xl/worksheets/sheet1.xml') => {
  const element = all(xml(parts, sheet), 'c').find((c) => c.getAttribute('r') === ref)!
  const child = (name: string) => all(element, name)[0]?.textContent
  return { formula: child('f'), value: child('v'), style: Number(element.getAttribute('s')) }
}

/** The PresetIDs animating each drawing of a slide, keyed by the drawing's name. */
const animations = (parts: Parts, slide: number) => {
  const doc = xml(parts, `ppt/slides/slide${slide}.xml`)
  const names = new Map(all(doc, 'cNvPr').map((nv) => [nv.getAttribute('id'), nv.getAttribute('name')]))
  const byName = new Map<string, string[]>()
  for (const effect of all(doc, 'cTn').filter((cTn) => cTn.hasAttribute('presetID'))) {
    for (const spid of new Set(all(effect, 'spTgt').map((target) => target.getAttribute('spid')))) {
      const name = names.get(spid) ?? `missing drawing ${spid}`
      byName.set(name, [...(byName.get(name) ?? []), effect.getAttribute('presetID')!])
    }
  }
  return Object.fromEntries(byName)
}

const transition = (parts: Parts, slide: number) =>
  all(xml(parts, `ppt/slides/slide${slide}.xml`), 'transition').map((element) => element.children[0]?.localName)

const slideParts = (parts: Parts) => Object.keys(parts).filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name))

const xlsxExamples: Example[] = [
  {
    name: 'a new workbook has values, formulas with results, currency cells, a red rule and a column chart',
    match: 'saveFile("budget.xlsx"',
    check: ({ output, files }) => {
      expect(output.files.map(({ filename }) => filename)).toEqual(['budget.xlsx'])
      // The months the red rule marks, which the reply may name.
      expect(output.logs).toBe('red months: Aug, Sep, Oct, Nov, Dec\nformula errors: []\n')
      expect(output.formulaErrors).toBeUndefined()
      const book = files['budget.xlsx']

      expect(cell(book, 'F2')).toMatchObject({ formula: 'SUM(C2:E2)', value: '4300' })
      expect(cell(book, 'B14')).toMatchObject({ formula: 'SUM(B2:B13)', value: '72000' })
      expect(cell(book, 'F14')).toMatchObject({ formula: 'SUM(F2:F13)', value: '68100' })

      const styles = xml(book, 'xl/styles.xml')
      const formats = new Map(
        all(styles, 'numFmt').map((f) => [f.getAttribute('numFmtId'), f.getAttribute('formatCode')]),
      )
      const cellFormats = all(all(styles, 'cellXfs')[0], 'xf')
      expect(formats.get(cellFormats[cell(book, 'F14').style].getAttribute('numFmtId'))).toBe('"$" #,##0.00')
      // Without Pattern: 1 a fill is saved as patternType "none" and shows nothing.
      const headerFill = all(all(styles, 'fills')[0], 'fill')[
        Number(cellFormats[cell(book, 'A1').style].getAttribute('fillId'))
      ]
      expect(all(headerFill, 'patternFill')[0].getAttribute('patternType')).toBe('solid')

      const [rule] = all(xml(book, 'xl/worksheets/sheet1.xml'), 'cfRule')
      expect(rule.parentElement?.getAttribute('sqref')).toBe('A2:F13')
      expect(rule.getAttribute('type')).toBe('expression')
      expect(all(rule, 'formula')[0].textContent).toBe('$F2>$B2')
      const highlight = all(all(styles, 'dxfs')[0], 'dxf')[Number(rule.getAttribute('dxfId'))]
      expect(all(highlight, 'color')[0].getAttribute('rgb')).toBe('FF9C0006')
      expect(all(highlight, 'bgColor')[0].getAttribute('rgb')).toBe('FFFFC7CE')
      expect(all(highlight, 'patternFill')[0].getAttribute('patternType')).toBe('solid')

      const chart = xml(book, 'xl/charts/chart1.xml')
      expect(all(chart, 'plotArea')[0].children[0]?.localName).toBe('barChart')
      expect(all(chart, 'barDir')[0].getAttribute('val')).toBe('col')
      expect(all(chart, 'f').map((f) => f.textContent)).toEqual([
        'Sheet1!$F$1',
        'Sheet1!$A$2:$A$13',
        'Sheet1!$F$2:$F$13',
      ])
      expect(text(all(chart, 'title')[0])).toBe('Monthly spending')
    },
  },
  {
    name: 'editing a workbook changes a value, adds a computed total and keeps the chart',
    match: 'const name = "sales.xlsx"',
    attachments: async () => ({ 'sales.xlsx': await fixture('WithChart.xlsx') }),
    check: async ({ output, files }) => {
      expect(output.files).toMatchObject([{ filename: 'sales.xlsx', edited: true }])
      expect(output.logs).toContain('[["1","10"],["2","12"],["3","14"],["4","9"],["5","15"],["6","17"]]')
      const book = files['sales.xlsx']
      expect(cell(book, 'B4').value).toBe('90')
      expect(cell(book, 'B7')).toMatchObject({ formula: 'SUM(B1:B6)', value: '158' })
      const original = unzipSync(await fixture('WithChart.xlsx'))
      expect(book['xl/charts/chart1.xml']).toEqual(original['xl/charts/chart1.xml'])
    },
  },
]

const docxExamples: Example[] = [
  {
    name: 'a new document has headings, lists, a table and page numbers',
    match: 'saveFile("report.docx"',
    check: ({ files }) => {
      const doc = files['report.docx']
      const body = xml(doc, 'word/document.xml')
      const styleOf = (p: Element) => all(p, 'pStyle')[0]?.getAttribute('w:val')
      const headings = all(body, 'p').filter((p) => /^(Title|Heading1)$/.test(styleOf(p) ?? ''))
      expect(headings.map((p) => [styleOf(p), text(p)])).toEqual([
        ['Title', 'Quarterly report'],
        ['Heading1', 'Summary'],
        ['Heading1', 'Results by region'],
        ['Heading1', 'Next steps'],
      ])
      const bold = all(body, 'r').filter((r) => all(r, 'b').length > 0)
      expect(bold.map(text)).toContain('12%')
      const [table] = all(body, 'tbl')
      expect(all(table, 'tr').map(text)).toEqual(['RegionRevenue', 'North$120,000', 'South$95,000'])
      expect(all(table, 'tblHeader')).toHaveLength(1)
      const lists = all(body, 'numId').map((numId) => numId.getAttribute('w:val'))
      expect(lists).toHaveLength(4)
      expect(new Set(lists).size).toBe(2)
      expect(strFromU8(doc['word/numbering.xml'])).toContain('<w:numFmt w:val="decimal"/>')
      const footer = all(xml(doc, 'word/footer1.xml'), 'instrText').map((field) => field.textContent?.trim())
      expect(footer).toEqual(['PAGE', 'NUMPAGES'])
    },
  },
  {
    name: 'a picture is embedded from an attached image',
    match: 'readFile("logo.png")',
    attachments: async () => ({ 'logo.png': await png() }),
    check: async ({ files }) => {
      const doc = files['logo.docx']
      const media = Object.keys(doc).filter((name) => name.startsWith('word/media/'))
      expect(media).toHaveLength(1)
      expect(doc[media[0]]).toEqual(await png())
      expect(all(xml(doc, 'word/document.xml'), 'blip')).toHaveLength(1)
    },
  },
  {
    name: 'patching a template fills its placeholders and keeps their formatting',
    match: 'patchDocument',
    attachments: async () => {
      const template = await run(`
const { Document, Packer, Paragraph, TextRun, HeadingLevel } = docx
const doc = new Document({ sections: [{ children: [
  new Paragraph({ text: "Proposal", heading: HeadingLevel.HEADING_1 }),
  new Paragraph({ children: [new TextRun("Prepared for "), new TextRun({ text: "{{client}}", bold: true }), new TextRun(" on {{date}}.")] }),
  new Paragraph("{{scope}}"),
  new Paragraph("Kind regards"),
] }] })
saveFile("proposal.docx", await Packer.toArrayBuffer(doc))`)
      return { 'proposal.docx': template.bytes['proposal.docx'] }
    },
    check: ({ output, files }) => {
      expect(output.files).toMatchObject([{ filename: 'proposal.docx', edited: true }])
      const doc = files['proposal.docx']
      expect(paragraphs(doc)).toEqual([
        'Proposal',
        'Prepared for Acme Ltd on 3 March 2027.',
        'Two workshops in March.',
        'A written report in April.',
        'Kind regards',
      ])
      const client = all(xml(doc, 'word/document.xml'), 'r').find((r) => text(r) === 'Acme Ltd')!
      expect(all(client, 'b')).toHaveLength(1)
    },
  },
  {
    name: 'an XML edit changes one run and leaves the comment alone',
    match: 'const name = "notes.docx"',
    attachments: async () => ({ 'notes.docx': await fixture('testComment.docx') }),
    check: async ({ output, files }) => {
      expect(output.files).toMatchObject([{ filename: 'notes.docx', edited: true }])
      expect(output.logs).toBe('["this is a comment paragraph!"]\n')
      const doc = files['notes.docx']
      expect(paragraphs(doc)).toEqual(['this is a comment section!'])
      expect(all(xml(doc, 'word/document.xml'), 'commentReference')).toHaveLength(1)
      const original = unzipSync(await fixture('testComment.docx'))
      expect(doc['word/comments.xml']).toEqual(original['word/comments.xml'])
    },
  },
]

const pptxExamples: Example[] = [
  {
    name: 'a new deck animates each named object and has a transition on each slide',
    match: 'saveFile("review.pptx"',
    check: ({ files }) => {
      const deck = files['review.pptx']
      expect(slideParts(deck)).toHaveLength(2)
      expect(all(xml(deck, 'ppt/presentation.xml'), 'sldSz')[0].getAttribute('cx')).toBe('12192000')
      // Preset IDs: fadeIn 10, flyIn 2, pulse 26, wipeIn 22.
      expect(animations(deck, 1)).toEqual({ title: ['10'], subtitle: ['2'], badge: ['26'] })
      expect(animations(deck, 2)).toEqual({ points: ['22'], regions: ['10'] })
      const badge = all(xml(deck, 'ppt/slides/slide1.xml'), 'cTn').find((cTn) => cTn.getAttribute('presetID') === '26')!
      expect(badge.getAttribute('repeatCount')).toBe('indefinite')
      expect(transition(deck, 1)).toEqual(['fade'])
      expect(transition(deck, 2)).toEqual(['push'])
      expect(all(xml(deck, 'ppt/slides/slide2.xml'), 'tbl')).toHaveLength(1)
      expect(all(xml(deck, 'ppt/charts/chart1.xml'), 'barDir')[0].getAttribute('val')).toBe('col')
    },
  },
  {
    name: 'a picture is added from an attached image',
    match: 'btoa(binary)',
    attachments: async () => ({ 'logo.png': await png() }),
    check: async ({ files }) => {
      const deck = files['logo.pptx']
      const media = Object.keys(deck).filter((name) => name.startsWith('ppt/media/') && !name.endsWith('/'))
      expect(media).toHaveLength(1)
      expect(deck[media[0]]).toEqual(await png())
      expect(all(xml(deck, 'ppt/slides/slide1.xml'), 'pic')).toHaveLength(1)
    },
  },
  {
    name: 'inspecting a deck logs its shapes and saves nothing',
    match: 'has animations',
    attachments: async () => ({ 'deck.pptx': await fixture('SampleShow.pptx') }),
    check: ({ output }) => {
      expect(output.files).toEqual([])
      expect(output.logs).toContain('<p:sldSz cx="9144000" cy="6858000" type="screen4x3"/>')
      expect(output.logs).toContain(
        'ppt/slides/slide1.xml [{"name":"The Title","text":"Title of the first slide"},{"name":"Another Subtitle"',
      )
    },
  },
  {
    name: 'editing a deck changes the title, animates it and keeps the notes',
    match: 'Results for 2027',
    attachments: async () => ({ 'deck.pptx': await fixture('SampleShow.pptx') }),
    check: async ({ output, files }) => {
      expect(output.files).toMatchObject([{ filename: 'deck.pptx', edited: true }])
      const deck = files['deck.pptx']
      expect(slideParts(deck)).toHaveLength(2)
      expect(all(xml(deck, 'ppt/slides/slide1.xml'), 't').map((t) => t.textContent)).toEqual([
        'Results for 2027',
        'Subtitle of the first slide',
        'This bit is in italic green',
      ])
      expect(animations(deck, 1)).toEqual({ 'The Title': ['10'] })
      expect(transition(deck, 2)).toEqual(['fade'])
      const original = unzipSync(await fixture('SampleShow.pptx'))
      expect(deck['ppt/notesSlides/notesSlide1.xml']).toEqual(original['ppt/notesSlides/notesSlide1.xml'])
    },
  },
]

/** The body of every fenced js block, in order. */
const examplesIn = (skill: string) => [...skill.matchAll(/```js\n([\s\S]*?)```/g)].map(([, body]) => body)

describe.each([
  { skill: 'office-xlsx', instructions: officeXlsxSkill, examples: xlsxExamples },
  { skill: 'office-docx', instructions: officeDocxSkill, examples: docxExamples },
  { skill: 'office-pptx', instructions: officePptxSkill, examples: pptxExamples },
])('$skill', ({ instructions, examples }) => {
  const blocks = examplesIn(instructions)

  it('stays at or under 12,000 characters, since a turn that loads it pays for all of it', () => {
    expect(instructions.length).toBeLessThanOrEqual(12_000)
  })

  it('pairs each fenced block with exactly one checked example, in order', () => {
    expect(blocks.length).toBeGreaterThan(0)
    // Every fence opens a js block, so no runnable code hides in a block of another language.
    expect(instructions.split('```').length - 1).toBe(blocks.length * 2)
    expect(
      blocks.map((block) => examples.filter(({ match }) => block.includes(match)).map(({ name }) => name)),
    ).toEqual(examples.map(({ name }) => [name]))
  })

  it.each(examples)('$name', async ({ match, attachments, check }) => {
    const block = blocks.find((candidate) => candidate.includes(match))
    if (!block) {
      throw new Error(`No example contains ${match}`)
    }
    await check(await run(block, await attachments?.()))
  })
})

it('states the workbook size limit the bridge enforces', () => {
  expect(officeXlsxSkill).toContain(`up to ${sandboxLimits.maxWorkbookBytes / 1024 / 1024} MiB`)
})
