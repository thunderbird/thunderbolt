/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { expect } from 'bun:test'
import { sampleDocxText } from './sample-docx'

/**
 * Asserts that a preview's markup shows what a reader of {@link sampleDocx} sees: both headings, every list item, the
 * table's cells in a table, and the picture embedded in the page. It checks no renderer's own markup, so it holds for
 * any renderer.
 */
export const expectSampleDocxPreview = (html: string) => {
  const page = new DOMParser().parseFromString(html, 'text/html')
  const text = page.body.textContent ?? ''
  const { title, section, bullets, steps, cells } = sampleDocxText
  for (const line of [title, section, ...bullets, ...steps]) {
    expect(text).toContain(line)
  }
  expect([...page.querySelectorAll('td')].map((td) => td.textContent?.trim())).toEqual(cells)
  expect([...page.querySelectorAll('img')].map((img) => img.getAttribute('src'))).toEqual([
    expect.stringMatching(/^data:image\/png;base64,/),
  ])
}
