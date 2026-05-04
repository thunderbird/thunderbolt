/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { type MouseEvent, useState } from 'react'
import type { CitationSource } from '@/types/citation'
import { useOpenExternalLink } from '@/components/chat/markdown-utils'
import { useProxyUrl } from '@/lib/proxy-url'
import { deriveFaviconUrl, isSafeUrl } from '@/lib/url-utils'
import { cn } from '@/lib/utils'

type SourceCardProps = {
  source: CitationSource
  className?: string
}

/**
 * Generates a color for the initial badge based on the site name
 */
const badgeColors = ['bg-chart-1', 'bg-chart-2', 'bg-chart-3', 'bg-chart-4', 'bg-chart-5']

const getBadgeColor = (siteName: string = '') => {
  const index = (siteName.charCodeAt(0) || 0) % badgeColors.length
  return badgeColors[index]
}

/**
 * Displays a single citation source with title and site badge
 * Matches Figma design: simple layout with circular initial badge
 */
export const SourceCard = ({ source, className }: SourceCardProps) => {
  const [faviconError, setFaviconError] = useState(false)
  const openExternalLink = useOpenExternalLink()
  const proxyUrl = useProxyUrl()

  const displayTitle = source.title || source.url
  const displaySiteName = source.siteName || 'Unknown'
  const safeUrl = isSafeUrl(source.url) ? source.url : '#'
  const explicitFavicon = source.favicon && isSafeUrl(source.favicon) ? source.favicon : null
  const derivedFavicon = deriveFaviconUrl(source.url)
  // Always route favicons through the proxy — direct cross-origin requests are
  // blocked by COEP (NotSameOriginAfterDefaultedToSameOriginByCoep), even when
  // the upstream URL is publicly reachable.
  const rawFavicon = explicitFavicon ?? derivedFavicon
  // proxyUrl returns null when the media JWT is still loading — the initial
  // letter badge below covers that case until the JWT resolves.
  const faviconUrl = rawFavicon ? proxyUrl(rawFavicon) : null
  const showFavicon = faviconUrl && !faviconError
  const initial = displaySiteName.charAt(0).toUpperCase()
  const badgeColor = getBadgeColor(displaySiteName)

  const handleClick = (e: MouseEvent<HTMLAnchorElement>) => {
    e.preventDefault()
    if (safeUrl === '#') {
      return
    }
    openExternalLink(safeUrl)
  }

  return (
    <a
      href={safeUrl}
      target="_blank"
      rel="noopener noreferrer"
      onClick={handleClick}
      className={cn('flex flex-col gap-2.5 px-4 py-3 hover:bg-accent/50 transition-colors cursor-pointer', className)}
      role="listitem"
    >
      <p className="text-base text-foreground leading-6 whitespace-pre-wrap">{displayTitle}</p>

      <div className="flex items-center gap-1.5">
        {showFavicon ? (
          <img
            src={faviconUrl}
            alt=""
            className="w-4 h-4 rounded-full flex-shrink-0"
            onError={() => setFaviconError(true)}
          />
        ) : (
          <div
            className={cn('w-4 h-4 rounded-full flex items-center justify-center flex-shrink-0', badgeColor)}
            aria-hidden="true"
          >
            <span className="text-white text-[11px] font-normal leading-4">{initial}</span>
          </div>
        )}
        <span className="text-xs text-muted-foreground leading-4">{displaySiteName}</span>
      </div>
    </a>
  )
}
