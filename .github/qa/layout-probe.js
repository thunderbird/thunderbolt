/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// The layout probe. The explore agent's browser runs it in every page (Playwright MCP `--init-script`) and repro
// specs inject it through layout.ts. It logs `[qa-layout] ready` once per page load and each confirmed problem once
// as `[qa-layout] <kind> <role> "<name>"`, all with console.error: the MCP passes on nothing quieter.
;(() => {
  if (window.top !== window || window.__qaLayout) return

  const interactive = 'input, textarea, select, button, a[href], [role=button], [role=link], [contenteditable=true]'
  const implicitRoles = { A: 'link', BUTTON: 'button', INPUT: 'textbox', SELECT: 'combobox', TEXTAREA: 'textbox' }
  const debounceMs = 250
  // A problem counts once it has been in every check for this long, so animations and transitions settle first.
  const confirmMs = 500
  // A page that never stops changing (a ticking clock, a streaming reply) is still measured this often, and
  // layoutProblems' 1 s wait still sees a problem confirmed.
  const maxWaitMs = 500

  const firstSeen = new Map()
  const logged = new Set()
  let confirmed = []
  let timer
  let pendingSince

  const clean = (text) => (text ?? '').replace(/\s+/g, ' ').trim()
  const accessibleName = (el) =>
    clean(el.getAttribute('aria-label')) ||
    clean(
      el
        .getAttribute('aria-labelledby')
        ?.split(/\s+/)
        .map((id) => document.getElementById(id)?.textContent)
        .join(' '),
    ) ||
    clean(el.labels?.[0]?.textContent) ||
    clean(el.textContent) ||
    clean(el.getAttribute('placeholder')) ||
    clean(el.getAttribute('title'))
  const describe = (el) =>
    `${el.getAttribute('role') || implicitRoles[el.tagName] || el.tagName.toLowerCase()} "${accessibleName(el).slice(0, 50)}"`

  const isVisible = (el) => {
    const rect = el.getBoundingClientRect()
    return rect.width > 0 && rect.height > 0 && el.checkVisibility({ opacityProperty: true, visibilityProperty: true })
  }
  // Behind a modal the background is aria-hidden or inert, or inherits the body's `pointer-events: none`. A disabled
  // control sets `pointer-events: none` on itself (ui/button.tsx) and still counts.
  const inheritsNoPointer = (el) =>
    getComputedStyle(el).pointerEvents === 'none' && getComputedStyle(el.parentElement).pointerEvents === 'none'
  const isCandidate = (el) => isVisible(el) && !el.closest('[aria-hidden=true], [inert]') && !inheritsNoPointer(el)

  // The math of src/hooks/use-keyboard-inset.ts.
  const keyboardOpen = (vv) => innerHeight - vv.height - vv.offsetTop > 100
  // With the keyboard open, behind-keyboard owns the area it hides, so the other checks measure the window.
  const viewArea = (vv) =>
    keyboardOpen(vv)
      ? { left: 0, top: 0, right: document.documentElement.clientWidth, bottom: innerHeight }
      : { left: vv.offsetLeft, top: vv.offsetTop, right: vv.offsetLeft + vv.width, bottom: vv.offsetTop + vv.height }

  // The ancestors that can clip or scroll el, below <body>. A fixed box ends the list: nothing above it moves it.
  const containersOf = (el) => {
    const chain = []
    for (let node = el; ; node = node.parentElement) {
      if (getComputedStyle(node).position === 'fixed') return { chain, fixed: node }
      if (!node.parentElement || node.parentElement === document.body) return { chain, fixed: null }
      chain.push(node.parentElement)
    }
  }

  const room = {
    up: (node) => node.scrollTop,
    down: (node) => node.scrollHeight - node.clientHeight - node.scrollTop,
    left: (node) => node.scrollLeft,
    right: (node) => node.scrollWidth - node.clientWidth - node.scrollLeft,
  }
  const axisOf = { up: 'overflowY', down: 'overflowY', left: 'overflowX', right: 'overflowX' }
  // How many pixels el's scrolling containers, the page included, can still move it in a direction.
  const scrollRoom = ({ chain, fixed }, direction) => {
    const axis = axisOf[direction]
    const lists = chain
      .filter((node) => /auto|scroll/.test(getComputedStyle(node)[axis]))
      .reduce((sum, node) => sum + room[direction](node), 0)
    const documentScrolls =
      !fixed &&
      ![document.documentElement, document.body].some((node) => /hidden|clip/.test(getComputedStyle(node)[axis]))
    return documentScrolls ? lists + room[direction](document.scrollingElement) : lists
  }

  const clipArea = ({ chain }, area) =>
    chain.reduce((box, node) => {
      const style = getComputedStyle(node)
      if (style.overflowX === 'visible' && style.overflowY === 'visible') return box
      const rect = node.getBoundingClientRect()
      return {
        left: Math.max(box.left, rect.left),
        top: Math.max(box.top, rect.top),
        right: Math.min(box.right, rect.right),
        bottom: Math.min(box.bottom, rect.bottom),
      }
    }, area)

  const isOffscreen = (rect, area, containers) => {
    // A drawer parked wholly past a side edge, like the collapsed desktop sidebar, is off canvas on purpose.
    const parked = containers.fixed?.getBoundingClientRect()
    if (parked && (parked.right <= area.left || parked.left >= area.right)) return false
    const directions = [
      rect.top < area.top - 1 && 'up',
      rect.bottom > area.bottom + 1 && 'down',
      rect.left < area.left - 1 && 'left',
      rect.right > area.right + 1 && 'right',
    ].filter(Boolean)
    return directions.some((direction) => scrollRoom(containers, direction) < 1)
  }

  // The fixed or sticky box the cover belongs to, unless el sits in it too: only that kind stays put while el scrolls.
  const pinnedCover = (hit, el) => {
    for (let node = hit; node && !node.contains(el); node = node.parentElement) {
      if (/fixed|sticky/.test(getComputedStyle(node).position)) return node
    }
    return null
  }

  const isExcusedCover = (hit) =>
    // A toast floats in a live region and leaves on its own. An inline alert over a control is still a bug.
    Boolean(hit.closest('[aria-live], [role=status], [role=alert], [role=log]') && containersOf(hit).fixed) ||
    // Popovers and tooltips open next to their trigger on purpose, over whatever sits beside it.
    Boolean(hit.closest('[data-radix-popper-content-wrapper], [role=tooltip]'))

  const isInside = (x, y, box) => x >= box.left && x <= box.right && y >= box.top && y <= box.bottom

  // What sits over el at (x, y), unless it is el's own content or an excused overlay.
  const coverAt = (x, y, el) => {
    const hit = document.elementFromPoint(x, y)
    return hit && !el.contains(hit) && !hit.contains(el) && !isExcusedCover(hit) ? hit : null
  }

  // A sticky header or fixed footer is fine when the page can still scroll el all the way out from under it.
  const isStuckUnder = (pinned, rect, containers) => {
    const cover = pinned.getBoundingClientRect()
    return cover.top + cover.height / 2 > innerHeight / 2
      ? scrollRoom(containers, 'down') < rect.bottom - cover.top
      : scrollRoom(containers, 'up') < cover.bottom - rect.top
  }

  const isCovered = (el, rect, area, containers) => {
    const x = (rect.left + rect.right) / 2
    const y = (rect.top + rect.bottom) / 2
    if (!isInside(x, y, clipArea(containers, area))) return false
    const hit = coverAt(x, y, el)
    if (!hit) return false
    const pinned = pinnedCover(hit, el)
    return !pinned || isStuckUnder(pinned, rect, containers)
  }

  // The focused element, and the buttons of every open dialog (the screen's main button may sit in the dialog under
  // a popover), or of the focused element's form when no dialog is open.
  const behindKeyboard = (vv, candidates) => {
    if (!keyboardOpen(vv)) return []
    const line = vv.offsetTop + vv.height
    const focused = document.activeElement
    const dialogs = [...document.querySelectorAll('[role=dialog], [role=alertdialog], dialog[open]')].filter(
      (dialog) => isVisible(dialog) && !dialog.closest('[aria-hidden=true], [inert]'),
    )
    const scopes = dialogs.length > 0 ? dialogs : [focused?.closest('form')].filter(Boolean)
    const buttons = candidates.filter(
      (el) => el.matches('button, [role=button]') && scopes.some((scope) => scope.contains(el)),
    )
    return [...new Set([focused, ...buttons])].filter((el) => {
      if (!candidates.includes(el)) return false
      const shift = el.getBoundingClientRect().bottom - line
      // The app must scroll the field you type in into view itself, so room to scroll it is no excuse.
      return shift > 1 && (el === focused || scrollRoom(containersOf(el), 'down') < shift)
    })
  }

  const textField =
    'textarea, [contenteditable=true], input:is(:not([type]), [type=text], [type=search], [type=email], [type=url], [type=tel], [type=password], [type=number])'

  const focusedField = () => {
    const el = document.activeElement
    return el?.matches(textField) && isCandidate(el) ? el : null
  }

  // With the keyboard open the focused field must show in full. One problem per cause: behind-keyboard owns the part
  // under the keyboard, this check owns the part above it that a clipping ancestor or the screen edge cuts off, and
  // focus-covered owns what a pinned box hides. A scroll box with room left is no excuse: the app failed to scroll.
  const isFocusedClipped = (vv, el) => {
    if (!keyboardOpen(vv)) return false
    const rect = el.getBoundingClientRect()
    const line = vv.offsetTop + vv.height
    if (rect.top >= line) return false
    const screen = { left: vv.offsetLeft, top: vv.offsetTop, right: vv.offsetLeft + vv.width, bottom: innerHeight }
    const clip = clipArea(containersOf(el), screen)
    return (
      rect.left < clip.left - 1 ||
      rect.top < clip.top - 1 ||
      rect.right > clip.right + 1 ||
      Math.min(rect.bottom, line) > clip.bottom + 1
    )
  }

  // The focused text field with any of a 5 x 3 grid of points, 2 px inside its edges, under a pinned box. Its center
  // can be free: the iOS keyboard's bar hides only its lower edge. Only without a keyboard may the page excuse the
  // cover by being able to scroll the field out from under it.
  const isFocusCovered = (vv, area, el) => {
    const rect = el.getBoundingClientRect()
    const containers = containersOf(el)
    const clip = clipArea(containers, area)
    const xs = [0, 1, 2, 3, 4].map((i) => rect.left + 2 + (i * (rect.width - 4)) / 4)
    const ys = [0, 1, 2].map((i) => rect.top + 2 + (i * (rect.height - 4)) / 2)
    return xs.some((x) =>
      ys.some((y) => {
        if (!isInside(x, y, clip)) return false
        const hit = coverAt(x, y, el)
        // An icon drawn over the field scrolls with it; only a fixed or sticky box stays over it.
        const pinned = hit && pinnedCover(hit, el)
        return Boolean(pinned) && (keyboardOpen(vv) || isStuckUnder(pinned, rect, containers))
      }),
    )
  }

  // The `overflow` check the explore prompt used to run by hand, now at every width.
  const overflows = () => {
    const root = document.documentElement
    const page =
      root.scrollWidth > root.clientWidth
        ? [{ kind: 'overflow-page', target: `document "${document.title.slice(0, 50)}"` }]
        : []
    const texts = [...document.querySelectorAll('body *')]
      .filter((el) => {
        if (el.childElementCount !== 0 || el.clientWidth <= 1 || el.textContent.trim() === '') return false
        if (el.scrollWidth <= el.clientWidth + 1) return false
        const style = getComputedStyle(el)
        return style.textOverflow !== 'ellipsis' && !/auto|scroll/.test(style.overflowX)
      })
      .slice(0, 10)
      .map((el) => ({ kind: 'overflow-text', target: describe(el) }))
    return [...page, ...texts]
  }

  const measure = () => {
    const vv = window.visualViewport
    const area = viewArea(vv)
    const candidates = [...document.querySelectorAll(interactive)].filter(isCandidate)
    const found = candidates.flatMap((el) => {
      const rect = el.getBoundingClientRect()
      const containers = containersOf(el)
      return [
        isOffscreen(rect, area, containers) && { kind: 'offscreen', target: describe(el) },
        isCovered(el, rect, area, containers) && { kind: 'covered', target: describe(el) },
      ].filter(Boolean)
    })
    const keyboard = behindKeyboard(vv, candidates).map((el) => ({ kind: 'behind-keyboard', target: describe(el) }))
    const field = focusedField()
    const focus = field
      ? [
          isFocusedClipped(vv, field) && { kind: 'focused-clipped', target: describe(field) },
          isFocusCovered(vv, area, field) && { kind: 'focus-covered', target: describe(field) },
        ].filter(Boolean)
      : []
    return [...found, ...keyboard, ...focus, ...overflows()]
  }

  const check = () => {
    clearTimeout(timer)
    pendingSince = undefined
    const now = performance.now()
    const current = new Map(measure().map((problem) => [`${problem.kind} ${problem.target}`, problem]))
    for (const key of firstSeen.keys()) if (!current.has(key)) firstSeen.delete(key)
    for (const key of current.keys()) if (!firstSeen.has(key)) firstSeen.set(key, now)
    const confirmedKeys = [...current.keys()].filter((key) => now - firstSeen.get(key) >= confirmMs)
    confirmed = confirmedKeys.map((key) => current.get(key))
    for (const key of confirmedKeys.filter((key) => !logged.has(key))) {
      logged.add(key)
      console.error(`[qa-layout] ${key}`)
    }
    if (confirmedKeys.length < current.size) schedule(confirmMs + 10)
  }

  const schedule = (delay) => {
    clearTimeout(timer)
    timer = setTimeout(check, delay)
  }

  const onChange = () => {
    pendingSince ??= performance.now()
    if (performance.now() - pendingSince >= maxWaitMs) check()
    else schedule(debounceMs)
  }

  const start = () => {
    new MutationObserver(onChange).observe(document, {
      subtree: true,
      childList: true,
      attributes: true,
      characterData: true,
    })
    addEventListener('resize', onChange)
    window.visualViewport.addEventListener('resize', onChange)
    window.visualViewport.addEventListener('scroll', onChange)
    // The page and its lists scrolling change what covers what, and the visual viewport never sees them.
    document.addEventListener('scroll', onChange, { capture: true, passive: true })
    document.addEventListener('focusin', onChange)
    check()
  }

  window.__qaLayout = { problems: () => [...confirmed] }
  console.error('[qa-layout] ready')
  if (document.readyState === 'complete') start()
  else addEventListener('load', start, { once: true })
})()
