/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Copy the active `--color-background` onto `<html>` and the `theme-color` meta.
 *
 * Reads the value from CSS after the theme class and any branding overrides
 * are in place, so index.css and the branding stylesheet stay the single
 * runtime source of truth for the page background (the pre-paint boot script
 * in index.html is the one unavoidable duplicate — it runs before the
 * stylesheet loads).
 */
export const syncDocumentBackground = () => {
  const root = document.documentElement
  const bgColor = getComputedStyle(root).getPropertyValue('--color-background').trim()
  root.style.backgroundColor = bgColor
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', bgColor)
}
