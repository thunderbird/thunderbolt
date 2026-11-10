/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Trans, useLingui } from '@lingui/react/macro'
import { Globe, Monitor } from 'lucide-react'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { DesktopBrowserPrompt } from './desktop-browser-prompt'

export const DesktopBrowserAddressBar = ({ url }: { url: string }) => {
  const { t } = useLingui()
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          data-desktop-browser-address-bar
          aria-label={t`Browse in the desktop app`}
          className="flex h-9 min-w-0 flex-1 cursor-pointer items-center gap-2 rounded-lg border border-border px-3 text-sm text-muted-foreground hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring dark:bg-input"
        >
          <Globe aria-hidden="true" className="size-3.5 shrink-0" />
          <span className="min-w-0 flex-1 truncate text-left" title={url || undefined}>
            {url || <Trans>Browse a website</Trans>}
          </span>
          <span className="flex shrink-0 items-center gap-1 rounded-md bg-muted px-2 py-0.5 text-xs">
            <Monitor aria-hidden="true" className="size-3" />
            <Trans>Desktop app</Trans>
          </span>
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80 max-w-[calc(100vw-2rem)]" aria-label={t`Browse in the desktop app`}>
        <DesktopBrowserPrompt externalUrl={url || undefined} />
      </PopoverContent>
    </Popover>
  )
}
