/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { CitationBadge } from '@/components/chat/citation-badge'
import { decodeCitationSources } from '@/lib/citation-utils'

type CitationWidgetProps = {
  sources: string
}

/**
 * Citation widget component - wrapper that receives parsed widget data
 * and renders CitationBadge with deserialized sources.
 *
 * Rendered outside a CitationPopoverProvider, so CitationBadge uses its
 * self-contained Popover/Sheet (no streaming re-render concerns here).
 */
export const CitationWidgetComponent = ({ sources: sourcesJson }: CitationWidgetProps) => {
  const sources = decodeCitationSources(sourcesJson)

  if (!sources) {
    return null
  }

  return <CitationBadge sources={sources} />
}

export { CitationWidgetComponent as Component }
