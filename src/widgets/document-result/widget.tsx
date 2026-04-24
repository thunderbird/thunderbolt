import { useContentView } from '@/content-view/context'
import { File, FileType2 } from 'lucide-react'
import { useCallback } from 'react'

type DocumentResultWidgetProps = {
  name: string
  fileId: string
  snippet?: string
  messageId: string
}

const getFileIcon = (fileName: string) => {
  const ext = fileName.split('.').pop()?.toLowerCase()
  if (ext === 'pdf') {
    return FileType2
  }
  return File
}

/**
 * Renders a source document card from Haystack search results.
 * Clicking opens the document in the sidebar viewer.
 */
export const DocumentResultWidget = ({ name, fileId, snippet }: DocumentResultWidgetProps) => {
  const { showSideview } = useContentView()
  const Icon = getFileIcon(name)

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
      </div>
    </div>
  )
}

export { DocumentResultWidget as Component }
