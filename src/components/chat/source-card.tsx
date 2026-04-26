import { type MouseEvent, useState } from 'react'
import type { CitationSource } from '@/types/citation'
import { buildDocumentSideviewId, isDocumentCitation } from '@/types/citation'
import { useContentView } from '@/content-view/context'
import { useOpenExternalLink } from '@/components/chat/markdown-utils'
import { deriveFaviconUrl, isSafeUrl } from '@/lib/url-utils'
import { cn } from '@/lib/utils'

type SourceCardProps = {
  source: CitationSource
  className?: string
  /** Base URL for the proxy endpoint (e.g., "http://localhost:8000/v1") to bypass COEP */
  proxyBase?: string
  /** Called after the source action fires (open link / show sideview) */
  onSelect?: () => void
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
export const SourceCard = ({ source, className, proxyBase, onSelect }: SourceCardProps) => {
  const [faviconError, setFaviconError] = useState(false)
  const openExternalLink = useOpenExternalLink()
  const { showSideview } = useContentView()

  const isDocument = isDocumentCitation(source)
  const displayTitle = source.title || source.url
  const displaySiteName = source.siteName || 'Unknown'
  const safeUrl = !isDocument && isSafeUrl(source.url) ? source.url : '#'
  const explicitFavicon = source.favicon && isSafeUrl(source.favicon) ? source.favicon : null
  const faviconUrl = explicitFavicon || (!isDocument ? deriveFaviconUrl(source.url, proxyBase) : null)
  const showFavicon = faviconUrl && !faviconError
  const initial = displaySiteName.charAt(0).toUpperCase()
  const badgeColor = getBadgeColor(displaySiteName)

  const handleClick = (e: MouseEvent<HTMLElement>) => {
    e.preventDefault()
    if (isDocument) {
      showSideview('document', buildDocumentSideviewId(source.documentMeta))
    } else if (safeUrl !== '#') {
      openExternalLink(safeUrl)
    }
    onSelect?.()
  }

  return (
    <button
      type="button"
      onClick={handleClick}
      className={cn(
        'flex flex-col gap-2.5 px-4 py-3 hover:bg-accent/50 transition-colors cursor-pointer w-full text-left',
        className,
      )}
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
    </button>
  )
}
