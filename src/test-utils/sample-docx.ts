/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Document, HeadingLevel, ImageRun, Packer, Paragraph, Table, TableCell, TableRow } from 'docx'

/** A 1×1 PNG, the picture in {@link sampleDocx}. */
export const pixelPng = Uint8Array.from(
  atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='),
  (char) => char.charCodeAt(0),
)

/** The text in {@link sampleDocx}, by where it sits in the document. */
export const sampleDocxText = {
  title: 'Quarterly report',
  section: 'Regions',
  bullets: ['Revenue grew in every region', 'Costs stayed flat'],
  steps: ['Review the forecast', 'Send it to finance'],
  cells: ['Region', 'Revenue', 'North', '1,200'],
}

const cell = (text: string) => new TableCell({ children: [new Paragraph(text)] })

/** A Word document with two headings, a bulleted and a numbered list, a table and a picture. */
export const sampleDocx = (): Promise<Blob> => {
  const { title, section, bullets, steps, cells } = sampleDocxText
  const document = new Document({
    numbering: { config: [{ reference: 'steps', levels: [{ level: 0, format: 'decimal', text: '%1.' }] }] },
    sections: [
      {
        children: [
          new Paragraph({ text: title, heading: HeadingLevel.HEADING_1 }),
          new Paragraph({ text: section, heading: HeadingLevel.HEADING_2 }),
          ...bullets.map((text) => new Paragraph({ text, bullet: { level: 0 } })),
          ...steps.map((text) => new Paragraph({ text, numbering: { reference: 'steps', level: 0 } })),
          new Table({
            rows: [
              new TableRow({ children: cells.slice(0, 2).map(cell) }),
              new TableRow({ children: cells.slice(2).map(cell) }),
            ],
          }),
          new Paragraph({
            children: [new ImageRun({ type: 'png', data: pixelPng, transformation: { width: 24, height: 24 } })],
          }),
        ],
      },
    ],
  })
  return Packer.toBlob(document)
}
