/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Globe } from 'lucide-react'
import { useState } from 'react'

/** Use declared page icons first, then the conventional icon on the current origin. */
export const browserFaviconCandidates = (pageUrl: string, icons: readonly string[] = []): string[] => {
  const page = URL.parse(pageUrl)
  if (!page || !['http:', 'https:'].includes(page.protocol)) {
    return []
  }
  return [...new Set([...icons.slice(0, 8), new URL('/favicon.ico', page).href])].filter((candidate) => {
    const url = candidate.length <= 8192 ? URL.parse(candidate) : null
    return url && ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password
  })
}

const FaviconImage = ({ candidates }: { candidates: readonly string[] }) => {
  const [index, setIndex] = useState(0)
  const source = candidates[index]
  if (!source) {
    return <Globe aria-hidden="true" className="size-3.5 shrink-0 text-muted-foreground" />
  }
  return (
    <img
      key={source}
      data-browser-favicon
      src={source}
      alt=""
      aria-hidden="true"
      referrerPolicy="no-referrer"
      draggable={false}
      className="size-3.5 shrink-0 object-contain"
      onError={() => setIndex((current) => current + 1)}
    />
  )
}

/** Reset failed-image fallback when navigation or the page's declared icon changes. */
export const BrowserFavicon = ({ url, icons }: { url: string; icons?: readonly string[] }) => {
  const candidates = browserFaviconCandidates(url, icons)
  return <FaviconImage key={JSON.stringify(candidates)} candidates={candidates} />
}
