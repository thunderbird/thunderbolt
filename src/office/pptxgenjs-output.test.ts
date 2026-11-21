/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'bun:test'
import { strFromU8, unzipSync } from 'fflate'
import { runSandboxedScript } from './sandbox'
import { loadTestSandboxRuntime } from './sandbox-test-runtime'

const runtime = await loadTestSandboxRuntime()

/** The parts of the one deck a script saves, as text. */
const deckParts = async (script: string) => {
  const result = await runSandboxedScript(runtime, { script, inputs: [] })
  if (!result.ok) {
    throw new Error(result.error)
  }
  return Object.fromEntries(
    Object.entries(unzipSync(result.files[0].bytes)).map(([name, data]) => [name, strFromU8(data)]),
  )
}

const chartDeck = (labels: string, outputType: string) => `
const pptx = new PptxGenJS()
for (let i = 0; i < 3; i++) pptx.addSlide().addText('Slide ' + (i + 1), { x: 1, y: 1 })
pptx.slides[2].addChart(pptx.ChartType.bar, [{ name: 'Sales', labels: ${labels}, values: [120, 150, 90] }], { x: 1, y: 1, w: 6, h: 4 })
saveFile('deck.pptx', await pptx.write({ outputType: '${outputType}' }))
`

describe('PptxGenJS output in the sandbox', () => {
  it('gives colliding tables unique IDs and keeps surrounding drawing IDs', async () => {
    const parts = await deckParts(`
const pptx = new PptxGenJS()
const slide = pptx.addSlide()
slide.addText('first', { objectName: 'First' })
slide.addTable([['a']], { objectName: 'A' })
slide.addTable([['b']], { objectName: 'B' })
slide.addText('last', { objectName: 'Last' })
saveFile('deck.pptx', await pptx.write({ outputType: 'uint8array' }))
`)
    const drawings = [...parts['ppt/slides/slide1.xml'].matchAll(/<p:cNvPr id="(\d+)" name="([^"]*)"/g)]
    const ids = drawings.map(([, id]) => id)
    expect(new Set(ids).size).toBe(drawings.length)
    expect(drawings.map(([, id, name]) => [id, name])).toContainEqual(['2', 'First'])
    expect(drawings.map(([, id, name]) => [id, name])).toContainEqual(['5', 'Last'])
  })

  it('declares content types only for parts the deck has', async () => {
    const parts = await deckParts(chartDeck(`['Jan', 'Feb', 'Mar']`, 'uint8array'))
    const declared = [...parts['[Content_Types].xml'].matchAll(/PartName="\/([^"]+)"/g)].map(([, name]) => name)

    expect(declared).toContain('ppt/slideMasters/slideMaster1.xml')
    expect(declared).toContain('ppt/slides/slide3.xml')
    expect(declared.filter((name) => !(name in parts))).toEqual([])
  })

  it('writes one-level chart categories as a plain string reference', async () => {
    const parts = await deckParts(chartDeck(`['Jan', 'Feb', 'Mar']`, 'arraybuffer'))
    const chart = parts['ppt/charts/chart1.xml']

    expect(chart).not.toContain('multiLvlStrRef')
    expect(chart).toContain(
      '<c:cat>  <c:strRef><c:f>Sheet1!$A$2:$A$4</c:f><c:strCache><c:ptCount val="3"/><c:pt idx="0"><c:v>Jan</c:v></c:pt><c:pt idx="1"><c:v>Feb</c:v></c:pt><c:pt idx="2"><c:v>Mar</c:v></c:pt></c:strCache></c:strRef></c:cat>',
    )
  })

  it('keeps categories with more than one level', async () => {
    const parts = await deckParts(chartDeck(`[['Jan', 'Feb', 'Mar'], ['Q1', '', '']]`, 'uint8array'))
    expect(parts['ppt/charts/chart1.xml']).toContain('<c:multiLvlStrRef>')
  })
})
