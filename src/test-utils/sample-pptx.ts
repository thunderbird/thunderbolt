/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import PptxGenJS from 'pptxgenjs'
import { pixelPng } from './sample-docx'

/** The text in {@link samplePptx}, by slide. */
export const samplePptxText = {
  title: 'Quarterly review',
  subtitle: 'Prepared for the board',
  titleNotes: 'Welcome everyone.',
  regions: 'Regions',
  bullets: ['Revenue grew in every region', 'Costs stayed flat'],
  cells: ['Region', 'Revenue', 'North', '1,200'],
  regionNotes: 'Mention the hiring plan.',
  chart: 'Revenue by quarter',
}

/**
 * A deck of three slides, made as the agent makes one: a title slide, a slide with bullets, a table and a picture,
 * and a bar chart. Its slides have no placeholders, so no text is marked as a title.
 */
export const samplePptx = async (): Promise<Uint8Array<ArrayBuffer>> => {
  const { title, subtitle, titleNotes, regions, bullets, cells, regionNotes, chart } = samplePptxText
  const deck = new PptxGenJS()
  deck.layout = 'LAYOUT_16x9'

  const first = deck.addSlide()
  first.addText(title, { x: 0.5, y: 1.5, w: 9, h: 1, fontSize: 40, bold: true })
  first.addText(subtitle, { x: 0.5, y: 2.7, w: 9, h: 0.6, fontSize: 20 })
  first.addNotes(titleNotes)

  const second = deck.addSlide()
  second.addText(regions, { x: 0.5, y: 0.3, w: 9, h: 0.8, fontSize: 32 })
  second.addText(
    bullets.map((text) => ({ text, options: { bullet: true, breakLine: true } })),
    { x: 0.5, y: 1.2, w: 4.5, h: 1.5, fontSize: 18 },
  )
  second.addTable(
    [
      [{ text: cells[0] }, { text: cells[1] }],
      [{ text: cells[2] }, { text: cells[3] }],
    ],
    { x: 5.2, y: 1.2, w: 4, fontSize: 14, border: { type: 'solid', pt: 1, color: '666666' } },
  )
  second.addImage({ data: `image/png;base64,${btoa(String.fromCharCode(...pixelPng))}`, x: 0.5, y: 3, w: 1, h: 1 })
  second.addNotes(regionNotes)

  const third = deck.addSlide()
  third.addChart(deck.ChartType.bar, [{ name: 'Revenue', labels: ['Q1', 'Q2', 'Q3'], values: [10, 20, 30] }], {
    x: 1,
    y: 0.5,
    w: 8,
    h: 4.5,
    showTitle: true,
    title: chart,
  })

  return (await deck.write({ outputType: 'uint8array' })) as Uint8Array<ArrayBuffer>
}
