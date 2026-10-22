/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useLingui } from '@lingui/react/macro'
import { Search } from 'lucide-react'
import type { ReactNode } from 'react'
import { Button, mutedIconButtonClass } from '@/components/ui/button'

/** Keep global search beside the section tabs in both sidebar views. */
export const SidebarHeaderActions = ({
  children,
  onSearchClick,
}: {
  children: ReactNode
  onSearchClick?: () => void
}) => {
  const { t } = useLingui()
  return (
    <div className="flex items-center gap-1">
      {onSearchClick && (
        <Button
          variant="ghost"
          size="icon"
          className={mutedIconButtonClass}
          aria-label={t`Search`}
          onClick={onSearchClick}
        >
          <Search />
        </Button>
      )}
      {children}
    </div>
  )
}
