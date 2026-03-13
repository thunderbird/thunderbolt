import { useContentView } from '@/content-view/context'
import { File, FileText, FileType2 } from 'lucide-react'
import { useCallback } from 'react'

type DocumentResultWidgetProps = {
  name: string
  fileId: string
  snippet?: string
  score?: string
  messageId: string
}

const getFileIcon = (fileName: string) => {
  const ext = fileName.split('.').pop()?.toLowerCase()
  if (ext === 'pdf') return FileType2
  if (ext === 'docx' || ext === 'doc') return FileText
  return File
}

/** Maps a 0-1 score to 1-5 notches for the relevance bar */
const getRelevanceLevel = (score: number): number => {
  if (score >= 0.8) return 5
  if (score >= 0.6) return 4
  if (score >= 0.4) return 3
  if (score >= 0.2) return 2
  return 1
}

const RelevanceBar = ({ score }: { score: number }) => {
  const level = getRelevanceLevel(score)
  return (
    <div className="flex shrink-0 flex-col items-start gap-1">
      <div className="flex w-full gap-0.5">
        {Array.from({ length: 5 }, (_, i) => (
          <div key={i} className={`h-1.5 flex-1 rounded-sm ${i < level ? 'bg-primary' : 'bg-muted'}`} />
        ))}
      </div>
      <span className="text-xs text-muted-foreground">Relevance</span>
    </div>
  )
}

/**
 * Renders a source document card from Haystack search results.
 * Shows file name, content snippet, and relevance bar.
 * Clicking opens the document in the sidebar viewer.
 */
export const DocumentResultWidget = ({ name, fileId, snippet, score }: DocumentResultWidgetProps) => {
  const { showSideview } = useContentView()
  const Icon = getFileIcon(name)
  const scoreValue = score ? Number.parseFloat(score) : null

  const handleClick = useCallback(() => {
    showSideview('document', `${fileId}:${name}`)
  }, [showSideview, fileId, name])

  return (
    <div
      onClick={handleClick}
      className="my-2 cursor-pointer rounded-lg border border-border bg-card p-5 shadow-sm transition-colors hover:bg-accent"
    >
      <div className="flex items-center gap-5">
        <div className="flex size-14 shrink-0 items-center justify-center rounded-md bg-muted">
          <Icon className="size-6 text-muted-foreground" />
        </div>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium">{name}</p>
          {snippet && <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">{snippet}</p>}
        </div>
        {scoreValue !== null && <RelevanceBar score={scoreValue} />}
      </div>
    </div>
  )
}

export { DocumentResultWidget as Component }
