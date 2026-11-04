/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Trans, useLingui } from '@lingui/react/macro'
import { ArrowLeft, MessageSquare } from 'lucide-react'
import { Link } from 'react-router'
import { Button } from '@/components/ui/button'
import { InlineArtifactCard } from '@/components/chat/inline-artifact-card'
import type { MessageArtifact } from '@/artifacts/library'

/** Use the same verified, sandboxed preview and protected HTML download as the original chat. */
export const MessageArtifactDetails = ({ artifact, onBack }: { artifact: MessageArtifact; onBack: () => void }) => {
  const { t } = useLingui()
  return (
    <div className="flex flex-col gap-4">
      <Button variant="ghost" size="sm" className="self-start" onClick={onBack}>
        <ArrowLeft />
        <Trans>Artifacts</Trans>
      </Button>
      <h2 className="text-xl font-semibold">{artifact.title ?? t`Artifact`}</h2>
      <Button variant="outline" className="self-start" asChild>
        <Link to={`/chats/${artifact.chatThreadId}`}>
          <MessageSquare />
          <Trans>Open original chat</Trans>
        </Link>
      </Button>
      <InlineArtifactCard html={artifact.html} title={artifact.title ?? t`Artifact`} />
    </div>
  )
}
