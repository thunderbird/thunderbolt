/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { MobileCardMenu } from '@/components/ui/mobile-card-menu'
import type { CitationSource } from '@/types/citation'
import { SourceList } from './source-list'

type CitationSourcesDrawerProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  sources: CitationSource[]
}

/** Mobile citation surface with swipe dismissal and a bounded source list. */
export const CitationSourcesDrawer = ({ open, onOpenChange, sources }: CitationSourcesDrawerProps) => (
  <MobileCardMenu
    open={open}
    onOpenChange={onOpenChange}
    title={`${sources.length} ${sources.length === 1 ? 'source' : 'sources'}`}
  >
    <div className="min-h-0 overflow-y-auto overscroll-contain pb-2">
      <SourceList sources={sources} onSelect={() => onOpenChange(false)} />
    </div>
  </MobileCardMenu>
)
