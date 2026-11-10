/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Trans } from '@lingui/react/macro'
import { ArrowLeft, ArrowRight } from 'lucide-react'
import { useLocation, useNavigate } from 'react-router'
import { useHistoryCeiling } from '@/hooks/use-history-ceiling'
import { Button } from './button'

/**
 * Back/forward history arrows for the Tauri desktop app, where there's no
 * browser chrome to navigate with. Web is skipped (the browser has its own
 * buttons) and so are mobile-width layouts (no room in the 3-column header).
 * Enabled state derives from react-router's history index (`history.state.idx`),
 * re-read on every location change.
 */
export const HistoryNavButtons = () => {
  const navigate = useNavigate()
  // Subscribe to location so the enabled states recompute after navigation.
  useLocation()
  const { index, ceiling } = useHistoryCeiling()

  const canGoBack = index > 0
  const canGoForward = index < ceiling

  return (
    <div className="flex items-center">
      <Button
        variant="ghost"
        size="icon"
        className="size-8 shrink-0 cursor-pointer rounded-full text-muted-foreground hover:text-foreground"
        disabled={!canGoBack}
        onClick={() => void navigate(-1)}
      >
        <ArrowLeft className="size-[var(--icon-size-default)]" />
        <span className="sr-only">
          <Trans>Go back</Trans>
        </span>
      </Button>
      <Button
        variant="ghost"
        size="icon"
        className="size-8 shrink-0 cursor-pointer rounded-full text-muted-foreground hover:text-foreground"
        disabled={!canGoForward}
        onClick={() => void navigate(1)}
      >
        <ArrowRight className="size-[var(--icon-size-default)]" />
        <span className="sr-only">
          <Trans>Go forward</Trans>
        </span>
      </Button>
    </div>
  )
}
