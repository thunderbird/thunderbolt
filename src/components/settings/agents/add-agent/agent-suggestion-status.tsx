/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Trans } from '@lingui/react/macro'
import { Loader2, Sparkles } from 'lucide-react'
import { Button } from '@/components/ui/button'
import type { AddAgentController } from './use-add-agent-state'

/** Keep suggestion progress and recovery visible without blocking manual configuration. */
export const AgentSuggestionStatus = ({ controller }: { controller: AddAgentController }) => {
  if (controller.suggestionStatus === 'idle') {
    return null
  }
  return (
    <div role="status" className="flex items-center gap-2 text-xs text-muted-foreground">
      {controller.suggestionStatus === 'pending' ? (
        <>
          <Loader2 className="size-3.5 animate-spin" />
          <Trans>Configuring…</Trans>
        </>
      ) : controller.suggestionStatus === 'ready' ? (
        <>
          <Sparkles className="size-3.5" />
          <Trans>Setup suggested</Trans>
        </>
      ) : (
        <>
          <Trans>Couldn’t suggest a setup.</Trans>
          <Button type="button" size="sm" variant="ghost" onClick={() => controller.suggest(true)}>
            <Trans>Retry</Trans>
          </Button>
        </>
      )}
    </div>
  )
}
