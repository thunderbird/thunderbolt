/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { beforeAll, describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import { bundleForBrowser } from '@/test-utils/bundle-for-browser'
import { sampleDocx } from '@/test-utils/sample-docx'
import type * as DocxToText from './docx-to-text'
import { docxMime } from '.'

describe('docx-to-text in the browser build', () => {
  let docx: typeof DocxToText

  beforeAll(async () => {
    // Under Bun mammoth resolves to its Node build, which cannot read an ArrayBuffer.
    docx = await bundleForBrowser<typeof DocxToText>(join(import.meta.dir, 'docx-to-text.ts'))
  })

  test('gives the model every heading, list item and table cell of an attached document, in reading order', async () => {
    const blob = await sampleDocx()

    const { text } = await docx.docxToText({
      id: 'file-1',
      filename: 'report.docx',
      mimeType: docxMime,
      size: blob.size,
      createdAt: 0,
      blob,
    })

    expect(text).toBe(
      [
        'Quarterly report',
        'Regions',
        'Revenue grew in every region',
        'Costs stayed flat',
        'Review the forecast',
        'Send it to finance',
        'Region',
        'Revenue',
        'North',
        '1,200',
      ].join('\n\n'),
    )
  })
})
