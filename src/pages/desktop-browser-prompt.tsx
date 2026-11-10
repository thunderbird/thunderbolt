/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Trans } from '@lingui/react/macro'
import { Download, ExternalLink } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { desktopDownloadsUrl } from '@/lib/download-links'

export const DesktopBrowserPrompt = ({ externalUrl }: { externalUrl?: string }) => (
  <div className="flex flex-col items-center gap-4 text-center">
    <div className="space-y-2">
      <h2 className="text-base font-semibold text-foreground">
        <Trans>Browse with your agent</Trans>
      </h2>
      <p className="text-sm leading-relaxed text-muted-foreground">
        <Trans>Open websites and let your agent work alongside you in the Thunderbolt desktop app.</Trans>
      </p>
    </div>
    <Button asChild>
      <a href={desktopDownloadsUrl} target="_blank" rel="noopener noreferrer">
        <Download className="size-4" />
        <Trans>Download desktop app</Trans>
      </a>
    </Button>
    {externalUrl && (
      <Button asChild variant="ghost" size="sm">
        <a href={externalUrl} target="_blank" rel="noopener noreferrer">
          <ExternalLink className="size-4" />
          <Trans>Open in your browser</Trans>
        </a>
      </Button>
    )}
  </div>
)
