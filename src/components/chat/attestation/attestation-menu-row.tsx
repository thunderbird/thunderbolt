/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { ChevronRight } from 'lucide-react'
import { searchableMenuRowClass } from '@/components/ui/searchable-menu'
import { cn } from '@/lib/utils'
import { useAttestationDisplay } from './use-attestation-display'
import { AttestationStatusIcon } from './attestation-status-icon'
import type { AttestationControlProps } from './props'

export const AttestationMenuRow = ({
  target,
  state,
  onClick,
}: Pick<AttestationControlProps, 'target' | 'state'> & { onClick: () => void }) => {
  const { label, status } = useAttestationDisplay(target, state)
  return (
    <div className="shrink-0 border-t p-1">
      <button
        type="button"
        aria-haspopup="dialog"
        onClick={onClick}
        className={cn(
          searchableMenuRowClass,
          'text-muted-foreground hover:bg-accent/50 hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring',
        )}
      >
        <AttestationStatusIcon status={status} className="size-4 shrink-0" />
        <span className="flex-1">{label}</span>
        <ChevronRight aria-hidden="true" className="size-3.5 shrink-0 opacity-60" />
      </button>
    </div>
  )
}
