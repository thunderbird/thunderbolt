/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useState, useTransition } from 'react'
import { Trans, useLingui } from '@lingui/react/macro'
import { PanelRight } from 'lucide-react'
import { verifyArtifactHtml } from '@/artifacts/verify-html'
import { useChatStore } from '@/chats/chat-store'
import { Button } from '@/components/ui/button'
import type { ToolOrDynamicToolUIPart } from '@/lib/assistant-message'
import { isTauriDesktop } from '@/lib/platform'
import { useLocalAppStore } from '@/local-apps/local-app-store'
import { pageController } from './page-controller'
import { pagePublicationFromPart } from './page-publications'
import { usePagePublication } from './page-publications-context'
import { usePageStore } from './page-store'

/** Opening tool history is inert; only this explicit user action may restore a page or launch its local app. */
export const PagePublicationAction = ({ part }: { part: ToolOrDynamicToolUIPart }) => {
  const { t } = useLingui()
  const published = pagePublicationFromPart(part)
  const latest = usePagePublication(published?.page.id ?? '')
  const session = usePageStore((state) => state.sessions.find((item) => item.page.id === published?.page.id))
  const page = session?.page ?? latest?.page ?? published?.page
  const localApp = useLocalAppStore((state) =>
    page?.source.kind === 'local-app' ? state.apps[page.source.appId] : undefined,
  )
  const [pending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)
  if (!page) {
    return null
  }
  const unavailable = page.source.kind === 'local-app' && (!isTauriDesktop() || !localApp || !!localApp.deletedAt)
  const open = () =>
    startTransition(async () => {
      setError(null)
      try {
        // Imported or restored history is untrusted. A fresh HTML host needs the same verification as a saved pin.
        if (!session && page.source.kind === 'html') {
          const result = await verifyArtifactHtml(page.source.html)
          if (!result.ok) {
            throw new Error(t`This saved HTML page could not be verified.`)
          }
        }
        const chatThreadId = useChatStore.getState().currentSessionId ?? undefined
        const id = usePageStore.getState().ensure(page, { chatThreadId })
        pageController.select(id)
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause))
      }
    })
  return (
    <div className="px-3 pb-2">
      <Button
        variant="outline"
        size="sm"
        disabled={pending || unavailable}
        title={unavailable ? t`This local app is unavailable on this device.` : page.title}
        onClick={open}
      >
        <PanelRight className="size-4" />
        <Trans>Open in side panel</Trans>
      </Button>
      {error && (
        <p role="alert" className="mt-2 text-sm text-destructive">
          {error}
        </p>
      )}
    </div>
  )
}
