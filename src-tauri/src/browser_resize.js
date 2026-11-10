/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

;(() => {
  const configuration = window.__browserResizeConfiguration
  const start = () => {
    const style = document.createElement('style')
    style.textContent = `
      html, body { margin: 0; width: 100%; height: 100%; overflow: hidden; background: transparent; cursor: col-resize; user-select: none; }
      #grip { box-sizing: border-box; display: flex; align-items: center; justify-content: center; width: 100%; height: 100%; border: 1px solid var(--border); border-radius: 8px; background: var(--background); color: var(--foreground); cursor: col-resize; touch-action: none; outline: none; }
      #grip:hover, #grip:active, #grip:focus-visible { background: var(--hover); }
      #grip:focus-visible { border-color: var(--foreground); }
      svg { width: 16px; height: 16px; pointer-events: none; }
    `
    document.head.append(style)
    const grip = document.createElement('div')
    grip.id = 'grip'
    grip.tabIndex = 0
    grip.setAttribute('role', 'separator')
    grip.setAttribute('aria-orientation', 'vertical')
    grip.setAttribute('aria-label', configuration.label)
    grip.innerHTML =
      '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="9" cy="12" r="1"/><circle cx="9" cy="5" r="1"/><circle cx="9" cy="19" r="1"/><circle cx="15" cy="12" r="1"/><circle cx="15" cy="5" r="1"/><circle cx="15" cy="19" r="1"/></svg>'
    document.body.append(grip)
    window.__browserResizeStyle = (colors) => {
      for (const [key, value] of Object.entries(colors)) {
        grip.style.setProperty(`--${key}`, value)
      }
    }
    window.__browserResizeStyle(configuration.colors)
    let sequence = Promise.resolve()
    let gesture = 0
    let pointer = null
    let lastScreenX = 0
    const send = (phase, screenX) => {
      const input = { owner: configuration.owner, gesture, phase, screenX }
      sequence = sequence
        .then(() => window.__TAURI_INTERNALS__.invoke('browser_resize_drag', { input }))
        .catch((error) => console.error('Could not resize browser', error))
    }
    grip.addEventListener('pointerdown', (event) => {
      if (!event.isTrusted || event.button !== 0 || pointer !== null) return
      event.preventDefault()
      pointer = event.pointerId
      lastScreenX = event.screenX
      gesture += 1
      grip.setPointerCapture(pointer)
      send('start', event.screenX)
    })
    grip.addEventListener('pointermove', (event) => {
      if (event.isTrusted && event.pointerId === pointer) {
        lastScreenX = event.screenX
        send('move', lastScreenX)
      }
    })
    const finish = (event) => {
      if (!event.isTrusted || event.pointerId !== pointer) return
      pointer = null
      send('end', event.type === 'pointerup' ? event.screenX : lastScreenX)
    }
    grip.addEventListener('pointerup', finish)
    grip.addEventListener('pointercancel', finish)
    grip.addEventListener('lostpointercapture', finish)
    grip.addEventListener('keydown', (event) => {
      if (!event.isTrusted || !['ArrowLeft', 'ArrowRight'].includes(event.key)) return
      event.preventDefault()
      gesture += 1
      send('start', 0)
      send('end', (event.key === 'ArrowLeft' ? -1 : 1) * (event.shiftKey ? 50 : 10))
    })
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true })
  else start()
})()
