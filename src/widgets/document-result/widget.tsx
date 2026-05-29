/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useContentView } from '@/content-view/context'
import { buildDocumentSideviewId } from '@/types/citation'
import { File, FileText, FileType2 } from 'lucide-react'
import { useCallback } from 'react'

type DocumentResultWidgetProps = {
  name: string
  fileId: string
  snippet?: string
  messageId?: string
}

const getFileIcon = (fileName: string) => {
  const ext = fileName.split('.').pop()?.toLowerCase()
  if (ext === 'pdf') {
    return FileType2
  }
  if (ext === 'docx' || ext === 'doc') {
    return FileText
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
    showSideview('document', buildDocumentSideviewId({ fileId, fileName: name }))
  }, [showSideview, fileId, name])

  return (
    <button
      type="button"
      onClick={handleClick}
      className="my-2 flex w-full cursor-pointer rounded-lg border border-border bg-card p-5 text-left shadow-sm transition-colors hover:bg-accent"
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
    </button>
  )
}

export { DocumentResultWidget as Component }
