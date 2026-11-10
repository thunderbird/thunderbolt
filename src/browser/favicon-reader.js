/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */
/* global document, location, matchMedia, URL */

// Fixed native metadata read; no page-to-host IPC or credentials are exposed.
;(() => ({
  url: location.href,
  icons: [...document.querySelectorAll('link[rel]')]
    .slice(0, 128)
    .filter((link) => {
      const relations = link.rel.toLowerCase().split(/\s+/)
      return (
        (relations.includes('icon') || relations.includes('apple-touch-icon')) &&
        (!link.media || matchMedia(link.media).matches)
      )
    })
    .sort(
      (a, b) =>
        Number(b.rel.toLowerCase().split(/\s+/).includes('icon')) -
        Number(a.rel.toLowerCase().split(/\s+/).includes('icon')),
    )
    .flatMap((link) => {
      const href = link.getAttribute('href')
      if (!href) {
        return []
      }
      try {
        return [new URL(href, document.baseURI).href]
      } catch {
        return []
      }
    })
    .filter((url, index, urls) => url.length <= 8192 && urls.indexOf(url) === index)
    .slice(0, 8),
}))()
