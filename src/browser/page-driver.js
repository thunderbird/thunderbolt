/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/* global window, crypto, getComputedStyle, innerHeight, innerWidth, document, clearTimeout, setTimeout,
   CSS, Element, location, HTMLInputElement, HTMLTextAreaElement, scrollX, scrollY */

// Evaluated inside an untrusted page by the privileged native adapter. This
// exposes observations only; it grants the page no IPC or native capabilities.
;(() => {
  if (window.__thunderboltBrowserDriver) return
  // getRandomValues also works on plain HTTP pages, where randomUUID is unavailable.
  const documentId = Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('')
  const refs = new Map()
  const ids = new WeakMap()
  let sequence = 0
  let picker = null
  let picked = null
  let cursorTimer
  const compact = (value, limit = 500) =>
    String(value || '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, limit)
  const rectOf = (element) => {
    const rect = element.getBoundingClientRect()
    return { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
  }
  const visible = (element) => {
    const rect = element.getBoundingClientRect()
    const style = getComputedStyle(element)
    return (
      rect.width > 0 &&
      rect.height > 0 &&
      rect.bottom > 0 &&
      rect.right > 0 &&
      rect.top < innerHeight &&
      rect.left < innerWidth &&
      style.visibility !== 'hidden' &&
      style.display !== 'none'
    )
  }
  const refOf = (element) => {
    if (!ids.has(element)) {
      const ref = `${documentId}:${++sequence}`
      ids.set(element, ref)
      refs.set(ref, element)
    }
    const ref = ids.get(element)
    // A framework can detach a node during one snapshot and reattach it before the next.
    refs.set(ref, element)
    return ref
  }
  const nameOf = (element) => {
    const root = element.getRootNode()
    const labelledBy = element
      .getAttribute('aria-labelledby')
      ?.split(/\s+/)
      .map((id) => root.getElementById?.(id)?.textContent)
      .join(' ')
    const labels = element.labels
      ? Array.from(element.labels)
          .map((label) => label.textContent)
          .join(' ')
      : ''
    return compact(
      element.getAttribute('aria-label') ||
        labelledBy ||
        labels ||
        element.getAttribute('alt') ||
        element.getAttribute('placeholder') ||
        element.innerText ||
        element.getAttribute('title'),
    )
  }
  const roleOf = (element) =>
    element.getAttribute('role') ||
    {
      a: 'link',
      button: 'button',
      textarea: 'textbox',
      select: 'combobox',
      option: 'option',
      img: 'img',
      h1: 'heading',
      h2: 'heading',
      h3: 'heading',
      iframe: 'iframe',
    }[element.localName] ||
    (element.localName === 'input'
      ? { checkbox: 'checkbox', radio: 'radio', button: 'button', submit: 'button' }[element.type] || 'textbox'
      : element.localName)
  const describe = (element) => ({
    ref: refOf(element),
    tag: element.localName,
    role: roleOf(element),
    name: nameOf(element),
    text: compact(element.innerText, 1000),
    rect: rectOf(element),
    ...('value' in element && element.type !== 'password' ? { value: compact(element.value, 1000) } : {}),
  })
  const overlay = document.createElement('div')
  overlay.setAttribute('data-thunderbolt-browser-overlay', '')
  overlay.style.cssText =
    'all:initial!important;position:fixed!important;inset:0!important;pointer-events:none!important;z-index:2147483647!important;'
  const shadow = overlay.attachShadow({ mode: 'closed' })
  const pointer = document.createElement('div')
  pointer.style.cssText =
    'display:none;position:fixed;width:24px;height:30px;margin-left:-2px;margin-top:-2px;transform-origin:2px 2px;pointer-events:none;filter:drop-shadow(0 1px 2px #1118);transition:left .12s ease,top .12s ease;'
  // Brand purple, raspberry, and amber stay visible against both light and dark pages.
  pointer.innerHTML = `<svg width="24" height="30" viewBox="0 0 24 30" aria-hidden="true">
    <defs><linearGradient id="thunderbolt-agent-cursor" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#6a00b1"/>
      <stop offset=".5" stop-color="#c12d6c"/>
      <stop offset="1" stop-color="#ab5e17"/>
    </linearGradient></defs>
    <path d="M3.5 2.6Q2 1.5 2 3.4V22.6Q2 24.5 3.4 23.2L8.1 18.8Q8.7 18.2 9.1 19L13.1 26.6Q13.7 27.8 14.9 27.2L16.3 26.5Q17.5 25.9 16.9 24.7L13.1 17.6Q12.7 16.8 13.6 16.8H20Q21.9 16.8 20.4 15.6Z" fill="url(#thunderbolt-agent-cursor)" stroke="white" stroke-width="1.7" stroke-linejoin="round" stroke-linecap="round"/>
  </svg>`
  const highlight = document.createElement('div')
  highlight.style.cssText =
    'display:none;position:fixed;box-sizing:border-box;border:2px solid #7965ff;background:#7965ff22;border-radius:3px;pointer-events:none;'
  shadow.append(highlight, pointer)
  const mount = () => {
    if (!overlay.isConnected) document.documentElement.append(overlay)
  }
  const cursor = (x, y, click = false) => {
    mount()
    clearTimeout(cursorTimer)
    pointer.style.display = 'block'
    pointer.style.left = `${x}px`
    pointer.style.top = `${y}px`
    pointer.style.transform = click ? 'scale(.8)' : 'none'
    cursorTimer = setTimeout(() => {
      pointer.style.display = 'none'
    }, 2200)
  }
  const selectorOf = (element) =>
    element.id
      ? `#${CSS.escape(element.id)}`
      : `${element.localName}${element.getAttribute('name') ? `[name=${JSON.stringify(element.getAttribute('name'))}]` : ''}`
  const stopPicker = () => {
    picker = null
    highlight.style.display = 'none'
  }
  const targetOf = (event) => event.composedPath().find((entry) => entry instanceof Element && entry !== overlay)
  const pointerMove = (event) => {
    if (!picker) return
    const element = targetOf(event)
    if (!element) return
    mount()
    const rect = rectOf(element)
    Object.assign(highlight.style, {
      display: 'block',
      left: `${rect.x}px`,
      top: `${rect.y}px`,
      width: `${rect.width}px`,
      height: `${rect.height}px`,
    })
  }
  const preventPickAction = (event) => {
    if (!picker) return
    event.preventDefault()
    event.stopImmediatePropagation()
  }
  const pickClick = (event) => {
    if (!picker) return
    const element = targetOf(event)
    preventPickAction(event)
    if (!element) return
    const info = describe(element)
    picked = {
      requestId: picker,
      url: location.href.slice(0, 8192),
      title: compact(document.title, 500),
      element: {
        id: info.ref,
        label: info.name || info.role,
        text: info.text || info.name,
        rect: info.rect,
        data: {
          selector: selectorOf(element),
          tag: info.tag,
          role: info.role,
          ...(element.href ? { href: compact(element.href, 2048) } : {}),
        },
      },
    }
    stopPicker()
  }
  document.addEventListener('pointermove', pointerMove, true)
  for (const event of ['pointerdown', 'mousedown', 'mouseup', 'pointerup', 'dblclick', 'contextmenu']) {
    document.addEventListener(event, preventPickAction, true)
  }
  document.addEventListener('click', pickClick, true)
  document.addEventListener(
    'keydown',
    (event) => {
      if (picker && event.key === 'Escape') {
        preventPickAction(event)
        picked = { requestId: picker, cancelled: true }
        stopPicker()
      }
    },
    true,
  )
  const elementAt = (x, y) => {
    let hit = document.elementFromPoint(x, y)
    while (hit?.shadowRoot?.elementFromPoint) {
      const inner = hit.shadowRoot.elementFromPoint(x, y)
      if (!inner || inner === hit) break
      hit = inner
    }
    return hit
  }
  const prepare = (action) => {
    if (picker) throw new Error('Finish or cancel element selection before controlling the browser.')
    let element
    if (action.ref) {
      element = refs.get(action.ref)
      if (!element?.isConnected) throw new Error('Stale element reference. Take a new browser snapshot.')
      element.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' })
      if (!visible(element)) throw new Error('Element is not visible.')
      if (element.disabled || element.getAttribute('aria-disabled') === 'true') throw new Error('Element is disabled.')
    }
    if (action.type === 'type') {
      element ||= document.activeElement
      const focusedFrame = !action.ref && (element?.localName === 'iframe' || element?.localName === 'frame')
      // A coordinate click can focus an editable field inside a cross-origin frame. Preserve that
      // native focus: focusing the outer frame again can blur the field we cannot inspect from here.
      if (!focusedFrame) {
        if (
          !(element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element?.isContentEditable)
        ) {
          throw new Error('Focus an editable element before typing.')
        }
        if (element.readOnly || element.disabled) throw new Error('Element is not editable.')
        element.focus({ preventScroll: true })
      }
    }
    if (element) {
      const rect = rectOf(element)
      const x = Math.max(0, rect.x) + (Math.min(innerWidth, rect.x + rect.width) - Math.max(0, rect.x)) / 2
      const y = Math.max(0, rect.y) + (Math.min(innerHeight, rect.y + rect.height) - Math.max(0, rect.y)) / 2
      const hit = elementAt(x, y)
      if (
        action.type === 'click' &&
        hit &&
        hit !== element &&
        !element.contains(hit) &&
        hit.getRootNode()?.host !== element
      ) {
        throw new Error('Element is covered by another element. Take a new snapshot or click a visible coordinate.')
      }
      return { x, y }
    }
    const x = action.x ?? innerWidth / 2
    const y = action.y ?? innerHeight / 2
    if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0 || x >= innerWidth || y >= innerHeight) {
      throw new Error('Coordinates must be inside the current viewport.')
    }
    return { x, y }
  }
  const snapshot = () => {
    const elements = []
    const query =
      'a[href],button,input:not([type=hidden]),textarea,select,[role],[tabindex],[contenteditable=true],h1,h2,h3,img[alt],iframe'
    const visit = (root) => {
      for (const element of root.querySelectorAll(query)) {
        if (element !== overlay && visible(element) && elements.length < 250) elements.push(describe(element))
      }
      for (const element of root.querySelectorAll('*')) {
        if (element.shadowRoot) visit(element.shadowRoot)
      }
    }
    visit(document)
    for (const [ref, element] of refs) if (!element.isConnected) refs.delete(ref)
    return {
      url: location.href.slice(0, 8192),
      title: compact(document.title, 500),
      documentId,
      viewport: { width: innerWidth, height: innerHeight, scrollX, scrollY },
      text: (document.body?.innerText || '').slice(0, 24000),
      elements,
      warnings: document.querySelector('iframe')
        ? ['Frame contents are not included in DOM references. Use a screenshot and coordinates for frames.']
        : [],
    }
  }
  window.__thunderboltBrowserDriver = {
    snapshot,
    prepare,
    cursor,
    setPicker: (enabled, requestId) => {
      if (enabled) {
        picker = requestId
        picked = null
        mount()
      } else if (picker === requestId) stopPicker()
      return true
    },
    takePick: (requestId) => {
      if (!picked || picked.requestId !== requestId) return picker === requestId ? null : { cancelled: true }
      const result = picked
      picked = null
      return result
    },
  }
})()
