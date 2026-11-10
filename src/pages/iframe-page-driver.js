/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/* global window, document, HTMLInputElement, HTMLTextAreaElement, InputEvent, KeyboardEvent, Event, Element */
;(() => {
  const driver = window.__thunderboltBrowserDriver
  const handlers = window.__artifactHandlers
  // WebKit may deny scripted focus in an opaque iframe. Keep the agent's input
  // target independent of host focus, which is restored to the chat after each action.
  let focusedElement = null
  const focus = (element) => {
    focusedElement = element
    element.focus?.({ preventScroll: true })
  }
  const activeElement = () => (focusedElement?.isConnected ? focusedElement : document.activeElement)
  document.addEventListener('focusin', (event) => {
    focusedElement = event.composedPath().find((entry) => entry instanceof Element) || null
  })
  handlers['page/snapshot'] = () => driver.snapshot()
  handlers['page/picker'] = ({ enabled, requestId }) => driver.setPicker(enabled, requestId)
  handlers['page/pick'] = ({ requestId }) => driver.takePick(requestId)
  handlers['page/action'] = (action) => {
    const point = driver.prepare(action, focus, activeElement)
    driver.cursor(point.x, point.y, action.type === 'click')
    if (action.type === 'move') return true
    if (action.type === 'scroll') {
      window.scrollBy(action.deltaX || 0, action.deltaY)
      return true
    }
    if (action.type === 'click') {
      if (action.button === 'right') throw new Error('Context-menu input requires a native browser.')
      let element = document.elementFromPoint(point.x, point.y)
      while (element?.shadowRoot?.elementFromPoint) {
        const inner = element.shadowRoot.elementFromPoint(point.x, point.y)
        if (!inner || inner === element) break
        element = inner
      }
      if (!element) throw new Error('No element at this position.')
      if (element.matches(':disabled') || element.getAttribute('aria-disabled') === 'true')
        throw new Error('Element is disabled.')
      focus(element)
      element.click()
      return true
    }
    let element = activeElement()
    while (element?.shadowRoot?.activeElement) element = element.shadowRoot.activeElement
    if (action.type === 'type') {
      if (!(element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement))
        throw new Error('Synthetic typing supports input and textarea fields only.')
      const setter = Object.getOwnPropertyDescriptor(
        element instanceof HTMLInputElement ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype,
        'value',
      ).set
      const start = action.clear ? 0 : (element.selectionStart ?? element.value.length)
      const end = action.clear ? element.value.length : (element.selectionEnd ?? start)
      setter.call(element, element.value.slice(0, start) + action.text + element.value.slice(end))
      try {
        element.setSelectionRange(start + action.text.length, start + action.text.length)
      } catch {
        /* Numeric inputs have no selection API. */
      }
      element.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: action.text }))
      element.dispatchEvent(new Event('change', { bubbles: true }))
      return true
    }
    if (action.type === 'key') {
      element.dispatchEvent(new KeyboardEvent('keydown', { key: action.key, bubbles: true }))
      element.dispatchEvent(new KeyboardEvent('keyup', { key: action.key, bubbles: true }))
      return true
    }
    throw new Error('Unsupported page action.')
  }
})()
