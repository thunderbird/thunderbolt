import { useState } from 'react'
import type { CitationSource } from '@/types/citation'
import { isSafeUrl } from '@/lib/citation-utils'
import { cn } from '@/lib/utils'

type SourceCardProps = {
  source: CitationSource
  className?: string
  /** Base URL for the proxy endpoint (e.g., "http://localhost:8000/v1") to bypass COEP */
  proxyBase?: string
}

/**
 * Generates a color for the initial badge based on the site name
 */
const getBadgeColor = (siteName: string = '') => {
  const colors = [
    'bg-[#7b8fff]', // blue
    'bg-[#f60]', // orange
    'bg-[#19ab78]', // green
    'bg-[#e11d48]', // red
    'bg-[#8b5cf6]', // purple
    'bg-[#f59e0b]', // amber
  ]
  const index = (siteName.charCodeAt(0) || 0) % colors.length
  return colors[index]
}

/** Derives a favicon URL from the source domain, proxied through the backend to bypass COEP */
const getFaviconUrl = (pageUrl: string, proxyBase?: string): string | null => {
  try {
    const { origin } = new URL(pageUrl)
    const faviconUrl = `${origin}/favicon.ico`
    return proxyBase ? `${proxyBase}/pro/proxy/${encodeURIComponent(faviconUrl)}` : faviconUrl
  } catch {
    return null
  }
}

/**
 * Displays a single citation source with title and site badge
 * Matches Figma design: simple layout with circular initial badge
 */
export const SourceCard = ({ source, className, proxyBase }: SourceCardProps) => {
  const [faviconError, setFaviconError] = useState(false)

  const displayTitle = source.title || source.url
  const displaySiteName = source.siteName || 'Unknown'
  const safeUrl = isSafeUrl(source.url) ? source.url : '#'
  const explicitFavicon = source.favicon && isSafeUrl(source.favicon) ? source.favicon : null
  const faviconUrl = explicitFavicon || getFaviconUrl(source.url, proxyBase)
  const showFavicon = faviconUrl && !faviconError
  const initial = displaySiteName.charAt(0).toUpperCase()
  const badgeColor = getBadgeColor(displaySiteName)

  return (
    <a
      href={safeUrl}
      target="_blank"
      rel="noopener noreferrer"
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
