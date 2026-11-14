/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate'
import { samplePptx } from '@/test-utils/sample-pptx'
import { withDeclaredSize, withZip64Count } from '@/test-utils/zip-fixtures'
import { pptxToText } from './pptx-to-text'
import { pptxMime } from '.'

const read = (bytes: Uint8Array) => {
  const blob = new Blob([new Uint8Array(bytes)], { type: pptxMime })
  return pptxToText({ id: 'deck', filename: 'deck.pptx', mimeType: pptxMime, size: blob.size, createdAt: 0, blob })
}

/** A deck PowerPoint saved, with title placeholders and speaker notes. */
const powerPointDeck = () => readFileSync(join(import.meta.dir, '../../office/test-fixtures/SampleShow.pptx'))

/** The PowerPoint deck with `change` applied to the text of each part it names. */
const edited = (change: Record<string, (xml: string) => string>) => {
  const parts = unzipSync(powerPointDeck())
  for (const [name, edit] of Object.entries(change)) {
    parts[name] = strToU8(edit(strFromU8(parts[name])))
  }
  return zipSync(parts)
}

/** A text box holding one paragraph, as a slide or notes page holds it. */
const textBox = (text: string) =>
  '<p:sp><p:nvSpPr><p:cNvPr id="90" name="Box"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr/><p:txBody><a:bodyPr/>' +
  `<a:p><a:r><a:t>${text}</a:t></a:r></a:p></p:txBody></p:sp>`

const headings = (text: string) => text.split('\n').filter((line) => line.startsWith('## '))

describe('pptxToText', () => {
  it('gives each slide its number and title, its other text, then its speaker notes', async () => {
    const { text } = await read(powerPointDeck())

    expect(text).toBe(
      [
        '## Slide 1: Title of the first slide',
        'Subtitle of the first slide',
        'This bit is in italic green',
        '',
        'Speaker notes:',
        'I am the notes of the first slide',
        '',
        '## Slide 2: This is the second slide',
        'It has bullet points on it',
        'They’re fun, aren’t they?',
        'Especially in a different font like Arial Black at 16 point!',
        '',
        'Speaker notes:',
        'These are the notes of the 2nd slide',
        'THIS LINE IS BOLD',
      ].join('\n'),
    )
  })

  it('keeps the text of a slide with no title placeholder, its table by rows, and a slide with only a chart', async () => {
    const { text } = await read(await samplePptx())

    expect(text).toBe(
      [
        '## Slide 1',
        'Quarterly review',
        'Prepared for the board',
        '',
        'Speaker notes:',
        'Welcome everyone.',
        '',
        '## Slide 2',
        'Regions',
        'Revenue grew in every region',
        'Costs stayed flat',
        'Region\tRevenue',
        'North\t1,200',
        '',
        'Speaker notes:',
        'Mention the hiring plan.',
        '',
        '## Slide 3',
      ].join('\n'),
    )
  })

  it('follows the order the deck shows its slides in, not the order of its files', async () => {
    const parts = unzipSync(powerPointDeck())
    const presentation = strFromU8(parts['ppt/presentation.xml'])
    parts['ppt/presentation.xml'] = strToU8(
      presentation.replace(
        '<p:sldId id="256" r:id="rId2"/><p:sldId id="257" r:id="rId3"/>',
        '<p:sldId id="257" r:id="rId3"/><p:sldId id="256" r:id="rId2"/>',
      ),
    )

    const { text } = await read(zipSync(parts))

    expect(text.split('\n').filter((line) => line.startsWith('## '))).toEqual([
      '## Slide 1: This is the second slide',
      '## Slide 2: Title of the first slide',
    ])
  })

  it('reads relationships whatever prefix their namespace has', async () => {
    const rels = 'ppt/_rels/presentation.xml.rels'
    const { text } = await read(
      edited({
        [rels]: (xml) =>
          xml
            .replace('<Relationships xmlns=', '<rel:Relationships xmlns:rel=')
            .replaceAll('<Relationship ', '<rel:Relationship ')
            .replace('</Relationships>', '</rel:Relationships>'),
      }),
    )

    expect(headings(text)).toEqual(['## Slide 1: Title of the first slide', '## Slide 2: This is the second slide'])
  })

  it('reads the content a file gives as a choice, not its fallback for older apps', async () => {
    const mc = 'http://schemas.openxmlformats.org/markup-compatibility/2006'
    const { text } = await read(
      edited({
        'ppt/slides/slide1.xml': (xml) =>
          xml.replace(
            '</p:spTree>',
            `<mc:AlternateContent xmlns:mc="${mc}"><mc:Choice Requires="p">${textBox('Choice text')}</mc:Choice>` +
              `<mc:Fallback>${textBox('Fallback text')}</mc:Fallback></mc:AlternateContent></p:spTree>`,
          ),
      }),
    )

    expect(text).toContain('Choice text')
    expect(text).not.toContain('Fallback text')
  })

  it('keeps a text box on the notes page, but not its slide number', async () => {
    const { text } = await read(
      edited({
        'ppt/notesSlides/notesSlide1.xml': (xml) =>
          xml.replace('</p:spTree>', `${textBox('Bring the handout')}</p:spTree>`),
      }),
    )

    expect(text).toContain('Speaker notes:\nI am the notes of the first slide\nBring the handout\n')
    expect(text).not.toMatch(/^1$/m)
  })

  it('reads a slide and its notes once, however many times the deck lists them', async () => {
    const slideList = Array.from(
      { length: 500 },
      (_, index) => `<p:sldId id="${300 + index}" r:id="${index % 2 ? 'rId3' : 'rId2'}"/>`,
    ).join('')
    const { text } = await read(
      edited({
        'ppt/presentation.xml': (xml) =>
          xml.replace(/<p:sldIdLst>.*<\/p:sldIdLst>/s, `<p:sldIdLst>${slideList}</p:sldIdLst>`),
        // The second slide shares the first one's notes.
        'ppt/slides/_rels/slide2.xml.rels': (xml) => xml.replace('notesSlide2.xml', 'notesSlide1.xml'),
      }),
    )

    expect(headings(text)).toEqual(['## Slide 1: Title of the first slide', '## Slide 2: This is the second slide'])
    expect(text.match(/I am the notes of the first slide/g)).toHaveLength(1)
  })

  it('gives a table row per line with empty cells kept, so the columns stay aligned', async () => {
    const cell = (text: string) =>
      `<a:tc><a:txBody><a:bodyPr/><a:p>${text && `<a:r><a:t>${text}</a:t></a:r>`}</a:p></a:txBody></a:tc>`
    const row = (...cells: string[]) => `<a:tr h="370840">${cells.map(cell).join('')}</a:tr>`
    const table =
      '<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="91" name="Table"/><p:cNvGraphicFramePr/><p:nvPr/>' +
      '</p:nvGraphicFramePr><p:xfrm/><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/table">' +
      `<a:tbl>${row('Region', 'Q1', 'Q2')}${row('North', '', '5')}${row('', '', '')}</a:tbl></a:graphicData></a:graphic></p:graphicFrame>`
    const { text } = await read(
      edited({ 'ppt/slides/slide2.xml': (xml) => xml.replace('</p:spTree>', `${table}</p:spTree>`) }),
    )

    expect(text).toContain('Region\tQ1\tQ2\nNorth\t\t5\n')
  })

  it('keeps a title with a line break on its heading, and leaves out the slide number, date and footer', async () => {
    const placeholder = (type: string, text: string) =>
      `<p:sp><p:nvSpPr><p:cNvPr id="92" name="${type}"/><p:cNvSpPr/><p:nvPr><p:ph type="${type}"/></p:nvPr></p:nvSpPr>` +
      `<p:spPr/><p:txBody><a:bodyPr/><a:p><a:r><a:t>${text}</a:t></a:r></a:p></p:txBody></p:sp>`
    const { text } = await read(
      edited({
        'ppt/slides/slide2.xml': (xml) =>
          xml
            .replace('This is the second slide', 'This is the</a:t></a:r><a:br/><a:r><a:t>second slide')
            .replace(
              '</p:spTree>',
              `${placeholder('sldNum', '2')}${placeholder('dt', '11/14/2026')}${placeholder('ftr', 'Confidential')}</p:spTree>`,
            ),
      }),
    )

    expect(text).toContain('## Slide 2: This is the second slide\nIt has bullet points on it')
    expect(text).not.toContain('Confidential')
    expect(text).not.toContain('11/14/2026')
  })

  it('reads a text box of many paragraphs in time that grows with its size', async () => {
    const paragraphs = Array.from({ length: 16_000 }, (_, index) => `<a:p><a:r><a:t>Point ${index}</a:t></a:r></a:p>`)
    const { text } = await read(
      edited({
        'ppt/slides/slide2.xml': (xml) =>
          xml
            .replace('</p:spTree>', `${textBox('Start')}</p:spTree>`)
            .replace('<a:p><a:r><a:t>Start</a:t></a:r></a:p>', paragraphs.join('')),
      }),
    )

    expect(text).toContain('Point 15999')
  })

  describe('a crafted deck', () => {
    const payload = 'X'.repeat(1024)
    const run = `<a:r><a:t>${payload}</a:t></a:r>`
    const count = (text: string) => text.split('').filter((char) => char === 'X').length
    const onSlide = (xml: string) =>
      read(edited({ 'ppt/slides/slide2.xml': (slide) => slide.replace('</p:spTree>', `${xml}</p:spTree>`) }))
    const inTextBox = (paragraphs: string) =>
      '<p:sp><p:nvSpPr><p:cNvPr id="93" name="Box"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr/><p:txBody>' +
      `<a:bodyPr/>${paragraphs}</p:txBody></p:sp>`
    const inTable = (rows: string) =>
      '<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="94" name="Table"/><p:cNvGraphicFramePr/><p:nvPr/>' +
      '</p:nvGraphicFramePr><p:xfrm/><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/table">' +
      `<a:tbl>${rows}</a:tbl></a:graphicData></a:graphic></p:graphicFrame>`
    const nest = (open: string, close: string, levels: number, inside: string) =>
      open.repeat(levels) + inside + close.repeat(levels)
    const fallback = (inside: string) =>
      `<mc:AlternateContent xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006">` +
      `<mc:Fallback>${inside}</mc:Fallback></mc:AlternateContent>`

    it('reads text nested in many paragraphs, runs or table rows once, not once per level', async () => {
      const decks = [
        inTextBox(nest('<a:p>', '</a:p>', 32, run)),
        inTextBox(`<a:p><a:r>${nest('<a:t>', '</a:t>', 32, payload)}</a:r></a:p>`),
        inTable(nest('<a:tr><a:tc><a:txBody>', '</a:txBody></a:tc></a:tr>', 32, `<a:p>${run}</a:p>`)),
        inTable(
          nest(
            '<a:tr><a:tc>',
            '</a:tc></a:tr>',
            8,
            nest('<a:p>', '</a:p>', 8, `<a:r>${nest('<a:t>', '</a:t>', 8, payload)}</a:r>`),
          ),
        ),
      ]

      for (const deck of decks) {
        expect(count((await onSlide(deck)).text)).toBe(payload.length)
      }
    })

    it('leaves out fallback content inside a paragraph, a run or a table row', async () => {
      const decks = [
        inTextBox(`<a:p>${fallback(run)}</a:p>`),
        inTextBox(`<a:p><a:r><a:t>${fallback(payload)}</a:t></a:r></a:p>`),
        inTable(`<a:tr><a:tc><a:txBody><a:p>${fallback(run)}</a:p></a:txBody></a:tc></a:tr>`),
      ]

      for (const deck of decks) {
        expect(count((await onSlide(deck)).text)).toBe(0)
      }
    })

    it('refuses a part nested deeper than 256 levels before parsing it', async () => {
      await expect(onSlide(inTextBox(nest('<a:p>', '</a:p>', 300, run)))).rejects.toThrow(
        'nests its content more than 256 levels deep',
      )
    })

    describe('refuses a part whose nesting the depth check could misread', () => {
      const deep = nest('<x>', '</x>', 300, '')
      const quotedDeep = deep.replaceAll('"', "'")
      // The prolog goes before the slide's root, and the deep nesting inside it.
      const beforeRoot = (prolog: string) =>
        read(
          edited({
            'ppt/slides/slide2.xml': (xml) =>
              xml.replace('?>', `?>${prolog}`).replace('</p:spTree>', `${deep}</p:spTree>`),
          }),
        )
      const cases = {
        'names outside the Unicode letters': () => onSlide(nest('<\u2160>', '</\u2160>', 300, '')),
        'names outside the Basic Multilingual Plane': () => onSlide(nest('<\u{10400}>', '</\u{10400}>', 300, '')),
        'a malformed start tag xmldom reads past': () => onSlide(`<bad "${quotedDeep}">`),
        'a malformed end tag xmldom reads past': () => onSlide(`<x></x\n "<skip>${quotedDeep}">`),
        'an attribute with no opening quote, which xmldom only warns about': () =>
          onSlide(`<x a=foo">${quotedDeep}"></x>`),
        'an unterminated attribute value': () => onSlide(`<bad attr="${quotedDeep}`),
        'a document type declaration whose comment holds closing tags': () =>
          beforeRoot(`<!DOCTYPE p:sld [<!-- > ${'</z>'.repeat(400)} -->]>`),
        'a document type declaration whose comment holds a quote': () => beforeRoot('<!DOCTYPE p:sld [<!-- " -->]>'),
        // Text boxes sit at depth 4, under the slide, its content and its shape tree.
        'an empty element at depth 257': () => onSlide(`${'<x>'.repeat(253)}<leaf/>${'</x>'.repeat(253)}`),
      }

      for (const [name, readDeck] of Object.entries(cases)) {
        it(name, async () => {
          await expect(readDeck()).rejects.toThrow()
        })
      }

      it('but keeps an empty element at depth 256', async () => {
        await expect(onSlide(`${'<x>'.repeat(252)}<leaf/>${'</x>'.repeat(252)}`)).resolves.toBeDefined()
      })

      it('but keeps a shallow element with a name outside the Unicode letters, and `/>` in a quoted value', async () => {
        const { text } = await onSlide(`<\u2160 a="/>"><y /></\u2160>${inTextBox(`<a:p>${run}</a:p>`)}`)

        expect(count(text)).toBe(payload.length)
      })
    })

    it('keeps a long run of spaces in a title, in time that grows with its length', async () => {
      const spaces = ' '.repeat(128 * 1024)
      const { text } = await read(
        edited({ 'ppt/slides/slide2.xml': (xml) => xml.replace('This is the second slide', `This${spaces}is it`) }),
      )

      expect(text).toContain(`## Slide 2: This${spaces}is it\n`)
    })
  })

  it('says so, for the model, when the deck has no slides it can read', async () => {
    await expect(
      read(edited({ 'ppt/presentation.xml': (xml) => xml.replace(/<p:sldIdLst>.*<\/p:sldIdLst>/s, '') })),
    ).rejects.toThrow('This presentation has no slides that could be read.')
  })

  it('refuses a part that unpacks to more than it declares, without inflating the rest of it', async () => {
    const parts = unzipSync(powerPointDeck())
    parts['ppt/slides/padding.xml'] = new Uint8Array(64 * 1024 * 1024).fill(32)

    await expect(read(withDeclaredSize(zipSync(parts), 'ppt/slides/padding.xml', 9))).rejects.toThrow(
      'unpacks to more than it declares',
    )
  })

  it('does not unpack pictures and other media, however large', async () => {
    const parts = unzipSync(powerPointDeck())
    parts['ppt/media/video.bin'] = new Uint8Array(40 * 1024 * 1024)

    const { text } = await read(zipSync(parts))

    expect(text).toStartWith('## Slide 1: Title of the first slide')
  })

  it('refuses a deck whose text unpacks to more than 32 MiB', async () => {
    const parts = unzipSync(powerPointDeck())
    parts['ppt/slides/padding.xml'] = new Uint8Array(33 * 1024 * 1024)

    await expect(read(zipSync(parts))).rejects.toThrow("This presentation's text unpacks to over 32 MiB")
  })

  it('refuses a zip that claims more parts than a classic zip can list', async () => {
    const zip = zipSync({ 'ppt/presentation.xml': strToU8('<p:presentation/>') }, { level: 0 })

    await expect(read(withZip64Count(zip, 70_000))).rejects.toThrow('more than 65535 parts')
  })
})
