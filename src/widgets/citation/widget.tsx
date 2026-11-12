/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { usePrivateSources } from '@/components/chat/private-sources-context'
import { CitationBadge } from '@/components/chat/citation-badge'
import { decodeCitationSources } from '@/lib/citation-utils'
import type { SourceMetadata } from '@/types/source'

type CitationWidgetProps = {
  sources: string
  sourceMetadata?: SourceMetadata[]
}

/**
 * Citation widget component - wrapper that receives parsed widget data
 * and renders CitationBadge with deserialized sources.
 *
 * Rendered outside a CitationPopoverProvider, so CitationBadge uses its
 * self-contained Popover/Sheet (no streaming re-render concerns here).
 */
export const CitationWidgetComponent = ({ sources: sourcesJson, sourceMetadata }: CitationWidgetProps) => {
  const privateEvidence = usePrivateSources(sourceMetadata)
  const sources = decodeCitationSources(sourcesJson)

  if (!sources) {
    return null
  }

  // Model-authored legacy citation JSON cannot opt a private message back into
  // fetching third-party favicons, including invented/unregistered source URLs.
  return (
    <CitationBadge
      sources={privateEvidence ? sources.map((source) => ({ ...source, allowRemoteImages: false })) : sources}
    />
  )
}

export { CitationWidgetComponent as Component }
