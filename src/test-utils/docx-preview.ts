/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { getClock } from '@/testing-library'
import { act } from '@testing-library/react'
import { expect } from 'bun:test'
import { sampleDocxText } from './sample-docx'

/**
 * Waits until the frame `find` returns holds its document. The renderer reads the file through real I/O and dynamic
 * imports that the fake clock never runs, so every step ticks the fake clock for React's scheduler and then yields one
 * turn of the real event loop. The bound is an iteration count, not a duration; a stuck renderer ends at the test's own
 * timeout.
 */
export const waitForPreviewFrame = async (find: () => Element | null) => {
  for (let i = 0; i < 10_000; i++) {
    const frame = find()
    if (frame instanceof HTMLIFrameElement && frame.srcdoc) {
      return frame
    }
    await act(async () => {
      await getClock().tickAsync(20)
      await new Promise((resolve) => setImmediate(resolve))
    })
  }
  throw new Error('The preview frame never got its document')
}

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
