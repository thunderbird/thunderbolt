/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useLingui } from '@lingui/react/macro'
import { Search } from 'lucide-react'
import type { ReactNode } from 'react'
import { Button, mutedIconButtonClass } from '@/components/ui/button'
import { SidebarMenuButton } from '@/components/ui/sidebar'

/** Keep global search with the section tabs in both sidebar views. */
export const SidebarHeaderActions = ({
  children,
  onSearchClick,
  vertical = false,
}: {
  children: ReactNode
  onSearchClick?: () => void
  vertical?: boolean
}) => {
  const { t } = useLingui()
  if (vertical) {
    return (
      <div className="mb-2 flex flex-col gap-4">
        {onSearchClick && (
          <SidebarMenuButton
            onClick={onSearchClick}
            tooltip={t`Search`}
            aria-label={t`Search`}
            className="cursor-pointer"
          >
            <Search />
          </SidebarMenuButton>
        )}
        {children}
      </div>
    )
  }

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
