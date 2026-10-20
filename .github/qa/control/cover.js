/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// The native positive control (spec 6.3): only the calibration build injects this, after layout-probe.js. While a text
// field has focus, a fixed button reading `qa-control-cover` sits over the lower half of it, so the layout check has to
// report the field whatever the keyboard does. It has a role and visible text because the WebView's accessibility
// bridge skips a bare div, and it takes pointer events because elementFromPoint, which the probe uses, skips the rest.
;(() => {
  const textField =
    'textarea, [contenteditable=true], input:is(:not([type]), [type=text], [type=search], [type=email], [type=url], [type=tel], [type=password], [type=number])'
  let cover
  let frame

  // The page scrolls the field into view after focus, so the cover follows it on every frame.
  const place = (field) => {
    const rect = field.getBoundingClientRect()
    const top = `${rect.top + rect.height / 2}px`
    const style = cover.style
    if (style.top !== top) style.top = top
    if (style.left !== `${rect.left}px`) style.left = `${rect.left}px`
    if (style.width !== `${rect.width}px`) style.width = `${rect.width}px`
    if (style.height !== `${rect.height / 2}px`) style.height = `${rect.height / 2}px`
    frame = requestAnimationFrame(() => place(field))
  }

  const remove = () => {
    cancelAnimationFrame(frame)
    cover?.remove()
    cover = undefined
  }

  document.addEventListener('focusin', (event) => {
    remove()
    if (!event.target.matches(textField)) return
    cover = document.createElement('div')
    cover.setAttribute('role', 'button')
    cover.textContent = 'qa-control-cover'
    cover.style.cssText =
      'position:fixed;z-index:2147483647;overflow:hidden;background:#e00;color:#fff;font:10px sans-serif;line-height:1'
    document.body.append(cover)
    place(event.target)
  })
  document.addEventListener('focusout', remove)
})()
