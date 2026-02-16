import type { CitationSource } from '@/types/citation'
import { SourceCard } from './source-card'
import { Separator } from '@/components/ui/separator'
import { cn } from '@/lib/utils'

type SourceListProps = {
  sources: CitationSource[]
  className?: string
  /** Base URL for the proxy endpoint to bypass COEP for favicon loading */
  proxyBase?: string
}

/**
 * Container component that renders multiple SourceCard components with dividers
 * Matches Figma design: dark background with border and dividers between items
 */
export const SourceList = ({ sources, className, proxyBase }: SourceListProps) => {
  if (sources.length === 0) {
    return <div className="text-muted-foreground text-sm text-center py-4">No sources available</div>
  }

  // Sort: primary source first, then others in original order
  const sortedSources = [...sources].sort((a, b) => {
    if (a.isPrimary === b.isPrimary) return 0
    return a.isPrimary ? -1 : 1
  })

  return (
    <div className={cn('overflow-hidden', className)} role="list">
      {sortedSources.map((source, index) => (
        <div key={source.id}>
          <SourceCard source={source} proxyBase={proxyBase} />
          {index < sortedSources.length - 1 && <Separator />}
        </div>
      ))}
    </div>
  )
}
