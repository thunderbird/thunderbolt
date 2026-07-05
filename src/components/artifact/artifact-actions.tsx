/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Button } from '@/components/ui/button'
import { useCopyToClipboard } from '@/hooks/use-copy-to-clipboard'
import { cn } from '@/lib/utils'
import { Check, Copy, Download } from 'lucide-react'

/** Filename-safe slug from a human title, e.g. "Sales Dashboard" → "sales-dashboard". */
const toFileSlug = (title: string): string =>
  title
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'artifact'

type ArtifactActionsProps = {
  html: string
  title: string
  /** Extra classes for each button (e.g. a hover circle that reads on a highlighting header). */
  buttonClassName?: string
}

/**
 * Header controls shared by the inline artifact card and the side-panel view:
 * copy the HTML source (with the same copy→check fade as the preview's copy-URL
 * button) and download it as a standalone `.html` file. Clicks stop propagation
 * so they never toggle the surrounding (collapsible) card header.
 */
export const ArtifactActions = ({ html, title, buttonClassName }: ArtifactActionsProps) => {
  const { copy, isCopied } = useCopyToClipboard()

  const handleDownload = () => {
    const url = URL.createObjectURL(new Blob([html], { type: 'text/html' }))
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = `${toFileSlug(title)}.html`
    document.body.appendChild(anchor)
    anchor.click()
    anchor.remove()
    // Defer revocation so the browser (notably WebKit in the Tauri webview) has time to start
    // reading the blob — revoking synchronously after click() can cancel the download.
    setTimeout(() => URL.revokeObjectURL(url), 10_000)
  }

  return (
    <>
      <Button
        onClick={(event) => {
          event.stopPropagation()
          void copy(html)
        }}
        variant="ghost"
        size="icon"
        className={cn('size-8 shrink-0 rounded-full', buttonClassName)}
        title="Copy HTML"
      >
        {isCopied ? <Check className="size-4 animate-[fadeOut_2s_ease-in-out]" /> : <Copy className="size-4" />}
      </Button>
      <Button
        onClick={(event) => {
          event.stopPropagation()
          handleDownload()
        }}
        variant="ghost"
        size="icon"
        className={cn('size-8 shrink-0 rounded-full', buttonClassName)}
        title="Download HTML"
      >
        <Download className="size-4" />
      </Button>
    </>
  )
}
