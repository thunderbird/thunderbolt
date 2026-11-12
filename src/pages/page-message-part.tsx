/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useEffect, useMemo, useRef, useState } from 'react'
import { Trans, useLingui } from '@lingui/react/macro'
import { ExternalLink, Globe, PanelRight } from 'lucide-react'
import type { PageDefinition } from '@shared/page-protocol'
import { verifyArtifactHtml } from '@/artifacts/verify-html'
import { useChatStore } from '@/chats/chat-store'
import { InlineArtifactCard } from '@/components/chat/inline-artifact-card'
import { EmbeddedErrorStrip } from '@/components/embedded'
import { Button } from '@/components/ui/button'
import { useAppSettled } from '@/hooks/use-app-settled'
import { useOnScreen } from '@/hooks/use-on-screen'
import { isTauri, isTauriDesktop } from '@/lib/platform'
import type { ToolOrDynamicToolUIPart } from '@/lib/assistant-message'
import { useLocalAppStore } from '@/local-apps/local-app-store'
import { InlinePage } from './inline-page'
import { pageController } from './page-controller'
import { usePageStore } from './page-store'
import { usePagePublication } from './page-publications-context'
import { publishedPageOutput } from './published-page-output'

/** Published page results retain the same document identity across transcript and browser placements. */
export const PageMessagePart = ({ part, messageId }: { part: ToolOrDynamicToolUIPart; messageId: string }) => {
  const published = useMemo(() => publishedPageOutput(part), [part])
  const latest = usePagePublication(published?.page.id ?? '')
  const chatThreadId = useChatStore((state) => state.currentSessionId)
  const page = useMemo(() => {
    if (!published) {
      return null
    }
    const current = latest?.page ?? published.page
    const source = current.source
    return source.kind === 'html'
      ? {
          ...current,
          source: { ...source, artifact: { toolCallId: part.toolCallId, messageId, ...source.artifact, chatThreadId } },
        }
      : current
  }, [published, latest, part.toolCallId, messageId, chatThreadId])
  if (latest && latest.firstToolCallId !== part.toolCallId) {
    return null
  }
  return page ? <PublishedPageCard page={page} presentation={latest?.presentation ?? published?.presentation} /> : null
}

type PublishedPageCardProps = {
  page: PageDefinition
  presentation?: 'inline' | 'sidebar'
}

const PublishedPageCard = ({ page, presentation }: PublishedPageCardProps) => {
  const { t } = useLingui()
  const ref = useRef<HTMLDivElement>(null)
  const settled = useAppSettled()
  const onScreen = useOnScreen(ref)
  const active = settled && onScreen
  const session = usePageStore((state) => state.sessions.find((item) => item.page.id === page.id))
  const currentPage = session?.page ?? page
  const localApp = useLocalAppStore((state) =>
    page.source.kind === 'local-app' ? state.apps[page.source.appId] : undefined,
  )
  const [verification, setVerification] = useState<{ html: string; error: string | null } | null>(null)
  const source = currentPage.source
  const html = source.kind === 'html' ? source.html : null
  // Websites and local apps are browser pages by default; legacy HTML keeps its inline placement.
  const placement = session?.presentation ?? presentation ?? (html !== null ? 'inline' : 'sidebar')
  // Synced tool results can be reopened long after the original verification. Recheck a
  // fresh HTML session; an existing live document must keep its state and never rerun here.
  useEffect(() => {
    if (!active || !html || session || placement !== 'inline') {
      return
    }
    let current = true
    void verifyArtifactHtml(html)
      .then((result) => {
        if (current) {
          setVerification({ html, error: result.ok ? null : result.errors.join(' · ') })
        }
      })
      .catch((error) => {
        if (current) {
          setVerification({ html, error: error instanceof Error ? error.message : String(error) })
        }
      })
    return () => {
      current = false
    }
  }, [active, html, session, placement])
  const verified = html === null || !!session || (verification?.html === html && verification.error === null)
  const verificationError = verification?.html === html ? verification.error : null
  const unavailableLocal = source.kind === 'local-app' && (!isTauriDesktop() || !localApp || !!localApp.deletedAt)
  // A restored/imported tool result is data, not authorization to launch a native process.
  const dormantLocal = source.kind === 'local-app' && !session
  const webExternal = source.kind === 'url' && !isTauri()
  const title =
    currentPage.title.trim() ||
    (source.kind === 'url' ? (source.url === 'about:blank' ? t`New tab` : source.url) : t`Page`)
  const open = () => {
    pageController.open(currentPage)
  }

  if (!unavailableLocal && !webExternal && (placement !== 'inline' || dormantLocal)) {
    return null
  }
  if (html !== null && verified) {
    return <InlineArtifactCard html={html} title={title} page={currentPage} onOpenInPanel={open} />
  }
  return (
    <div ref={ref} data-published-page={page.id} className="my-2 overflow-hidden rounded-xl border border-border">
      <div className="flex min-h-10 items-center gap-2 border-b px-3 py-1">
        <Globe className="size-4 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate text-sm font-medium">{title}</span>
        {!unavailableLocal && !webExternal && verified && (
          <Button
            variant="ghost"
            size="icon"
            className="size-8 rounded-full"
            title={t`Open in side panel`}
            onClick={open}
          >
            <PanelRight className="size-4" />
          </Button>
        )}
      </div>
      {unavailableLocal ? (
        <p className="p-4 text-sm text-muted-foreground">
          <Trans>
            This local app is available in the desktop app on the computer where it was created. Its files do not sync.
          </Trans>
        </p>
      ) : webExternal ? (
        <div className="space-y-3 p-4 text-sm text-muted-foreground">
          <p>
            <Trans>This website opens in your browser.</Trans>
          </p>
          <a
            href={source.url}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-2 rounded-xl border px-3 py-2 text-foreground hover:bg-accent"
          >
            <ExternalLink className="size-4" />
            <Trans>Open in your browser</Trans>
          </a>
        </div>
      ) : !verified ? (
        verificationError ? (
          <EmbeddedErrorStrip message={verificationError} />
        ) : (
          <p role="status" className="p-4 text-sm text-muted-foreground">
            <Trans>Checking this page…</Trans>
          </p>
        )
      ) : (
        <InlinePage page={currentPage} enabled={active} />
      )}
    </div>
  )
}
