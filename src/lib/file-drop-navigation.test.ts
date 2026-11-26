/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it, mock } from 'bun:test'
import { installFileDropNavigationPrevention } from './file-drop-navigation'

/** Happy DOM has no DragEvent constructor; supply transfer data on a real bubbling DOM event. */
const dragEvent = (type: 'dragover' | 'drop', types: readonly string[] | null = ['Files']) => {
  const event = new Event(type, { bubbles: true, cancelable: true })
  Object.defineProperty(event, 'dataTransfer', { value: types === null ? null : { types } })
  return event
}

describe('file drop navigation', () => {
  it.each(['dragover', 'drop'] as const)('cancels file %s outside a drop target', (type) => {
    const page = document.implementation.createHTMLDocument()
    installFileDropNavigationPrevention(page)

    const event = dragEvent(type)
    page.body.dispatchEvent(event)

    expect(event.defaultPrevented).toBe(true)
  })

  it.each(['dragover', 'drop'] as const)('preserves target handlers and propagation for file %s', (type) => {
    const page = document.implementation.createHTMLDocument()
    installFileDropNavigationPrevention(page)
    const composer = page.createElement('div')
    page.body.append(composer)
    const handleDrop = mock((event: Event) => {
      expect(event.defaultPrevented).toBe(false)
      event.preventDefault()
    })
    const observeDrop = mock((event: Event) => expect(event.defaultPrevented).toBe(true))
    composer.addEventListener(type, handleDrop)
    page.addEventListener(type, observeDrop)

    composer.dispatchEvent(dragEvent(type))

    expect(handleDrop).toHaveBeenCalledTimes(1)
    expect(observeDrop).toHaveBeenCalledTimes(1)
  })

  it.each([
    { label: 'plain text', types: ['text/plain'] },
    { label: 'URLs', types: ['text/uri-list'] },
    { label: 'text and URLs', types: ['text/plain', 'text/uri-list'] },
    { label: 'an empty transfer', types: [] },
    { label: 'no transfer', types: null },
  ])('leaves $label unchanged', ({ types }) => {
    const page = document.implementation.createHTMLDocument()
    installFileDropNavigationPrevention(page)
    for (const type of ['dragover', 'drop'] as const) {
      const event = dragEvent(type, types)
      page.body.dispatchEvent(event)
      expect(event.defaultPrevented).toBe(false)
    }
  })

  it('still cancels file navigation when the transfer also contains a URL', () => {
    const page = document.implementation.createHTMLDocument()
    installFileDropNavigationPrevention(page)
    const event = dragEvent('drop', ['text/uri-list', 'Files'])

    page.body.dispatchEvent(event)

    expect(event.defaultPrevented).toBe(true)
  })

  it('removes both listeners on cleanup', () => {
    const page = document.implementation.createHTMLDocument()
    const remove = installFileDropNavigationPrevention(page)
    remove()

    for (const type of ['dragover', 'drop'] as const) {
      const event = dragEvent(type)
      page.body.dispatchEvent(event)
      expect(event.defaultPrevented).toBe(false)
    }
  })
})
