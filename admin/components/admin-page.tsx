/* UNLICENSED — license TBD. This file is not licensed under MPL-2.0.
 * All rights reserved. See admin/LICENSE.
 * Enterprise support and licensing: contact info@thunderbolt.io. */

import type { ReactNode } from 'react'
import { DetailPanelSurface } from '@/components/detail-panel'
import { SettingsListBody, SettingsListPane, settingsListBodyRowsClass } from '@/components/settings/settings-list'
import { PageHeader } from '@/components/ui/page-header'
import { PageSearch } from '@/components/ui/page-search'
import { useIsMobile } from '@/hooks/use-mobile'

type AdminPageProps = {
  title: string
  /** Beside the title; on phones, at the top of the list, since the floating header has no room for it. */
  action?: ReactNode
  actionsClassName?: string
  search?: { placeholder: string; label: string; onSearch: (value: string) => void }
  /** The detail panel beside the list; pass `onClose` with it. */
  panel?: ReactNode
  onClose?: () => void
  children?: ReactNode
}

/** The settings list layout, header and detail surface, shared by every admin screen. */
export const AdminPage = ({ title, action, actionsClassName, search, panel, onClose, children }: AdminPageProps) => {
  const { isMobile } = useIsMobile()
  const header = (
    <PageHeader title={title} actionsClassName={actionsClassName}>
      {search && <PageSearch.Button />}
      {!isMobile && action}
    </PageHeader>
  )
  return (
    <div className="relative flex h-full">
      <div className="min-w-0 flex-1 overflow-hidden">
        <SettingsListPane>
          {search ? (
            <PageSearch onSearch={search.onSearch}>
              {header}
              <PageSearch.Input
                role="searchbox"
                aria-label={search.label}
                placeholder={search.placeholder}
                onSearch={search.onSearch}
              />
            </PageSearch>
          ) : (
            header
          )}
          <SettingsListBody className={settingsListBodyRowsClass}>
            {/* The header's in-flow actions would sit under this scrolling body on phones. `PageCreateAction`
                portals itself out, leaving the row empty. */}
            {isMobile && action && <div className="flex justify-end gap-2 empty:hidden">{action}</div>}
            {children}
          </SettingsListBody>
        </SettingsListPane>
      </div>
      {onClose && (
        <DetailPanelSurface open={!!panel} onClose={onClose}>
          {panel}
        </DetailPanelSurface>
      )}
    </div>
  )
}
