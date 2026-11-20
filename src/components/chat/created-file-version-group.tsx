/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Plural } from '@lingui/react/macro'
import type { CreatedFileVersions } from '@/lib/assistant-message'
import { ChevronDown } from 'lucide-react'
import { useState } from 'react'
import { CreatedFileCard } from './created-file-card'

export const CreatedFileVersionGroup = ({ versions: { latest, earlier } }: { versions: CreatedFileVersions }) => {
  const [expanded, setExpanded] = useState(false)
  const latestChip = <CreatedFileCard key={latest.id} file={latest} />
  if (!earlier.length) {
    return latestChip
  }

  return (
    <div className="flex max-w-full flex-col items-start gap-1">
      {latestChip}
      <button
        type="button"
        aria-expanded={expanded}
        onClick={() => setExpanded(!expanded)}
        className="flex min-h-[var(--min-touch-height)] items-center gap-1 rounded-lg px-1 text-[length:var(--font-size-xs)] text-muted-foreground hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
      >
        <ChevronDown aria-hidden="true" className={expanded ? 'size-4 rotate-180' : 'size-4'} />
        <Plural value={earlier.length} one="# earlier version" other="# earlier versions" />
      </button>
      {expanded && (
        <div className="flex flex-wrap items-start gap-2">
          {earlier.map((file) => (
            <CreatedFileCard key={file.id} file={file} />
          ))}
        </div>
      )}
    </div>
  )
}
