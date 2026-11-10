/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'bun:test'
import { buildQuotePart, hydrateQuotesAsText, renderMessageQuotesAsText } from '@/lib/quotes'
import {
  parseBrowserPickerResult,
  toBrowserElementPassage,
  type BrowserElementSelection,
} from './browser-element-reference'

const selection: BrowserElementSelection = {
  url: 'https://example.com/cart',
  title: 'Shopping cart',
  element: {
    id: 'doc-1:element-4',
    label: 'Checkout',
    text: 'Checkout — 2 items',
    rect: { x: 10, y: 30, width: 200, height: 50 },
    data: { selector: '#checkout', tag: 'button', role: 'button' },
  },
}

describe('browser element references', () => {
  it('keeps the selected passage and actionable tab/ref through quote persistence and both agent transports', () => {
    const text = toBrowserElementPassage(selection, 'sidebar-webview-tab1')
    const message = { id: 'message1', role: 'user' as const, parts: [buildQuotePart({ text })] }
    const restored = JSON.parse(JSON.stringify(message)) as typeof message
    expect(text.startsWith('Checkout\nCheckout — 2 items\n')).toBe(true)
    expect(text).toContain('"tabId":"sidebar-webview-tab1"')
    expect(text).toContain('"elementRef":"doc-1:element-4"')
    expect(text).toContain('"url":"https://example.com/cart"')
    expect(hydrateQuotesAsText([restored])[0].parts).toEqual([
      { type: 'text', text: renderMessageQuotesAsText(restored) },
    ])
    expect(renderMessageQuotesAsText(restored)).toContain('> Browser reference:')
  })

  it('bounds untrusted text and strips unexpected page-provided fields', () => {
    const result = parseBrowserPickerResult({
      ...selection,
      title: 'x'.repeat(1_000),
      element: {
        ...selection.element,
        text: 'y'.repeat(50_000),
        data: { ...selection.element.data, cookie: 'must not be retained' },
      },
    })
    expect(result).toMatchObject({ title: 'x'.repeat(256), element: { text: 'y'.repeat(8_000) } })
    expect(result && 'element' in result && result.element.data).not.toHaveProperty('cookie')
  })

  it('accepts pending and cancelled gestures and rejects malformed geometry or empty references', () => {
    expect(parseBrowserPickerResult(null)).toBeNull()
    expect(parseBrowserPickerResult({ cancelled: true })).toEqual({ cancelled: true })
    expect(() => parseBrowserPickerResult({ ...selection, element: { ...selection.element, id: '' } })).toThrow()
    expect(() =>
      parseBrowserPickerResult({
        ...selection,
        element: { ...selection.element, rect: { x: Infinity, y: 0, width: 10, height: 10 } },
      }),
    ).toThrow()
  })
})
