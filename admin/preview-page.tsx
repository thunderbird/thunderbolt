/* UNLICENSED — license TBD. This file is not licensed under MPL-2.0.
 * All rights reserved. See admin/LICENSE.
 * Enterprise support and licensing: contact info@thunderbolt.io. */

import type { ReactNode } from 'react'
import { DetailPanelSurface } from '@/components/detail-panel'
import { SettingsListBody, SettingsListPane, settingsListBodyRowsClass } from '@/components/settings/settings-list'
import { PageHeader } from '@/components/ui/page-header'
import { PageSearch } from '@/components/ui/page-search'

/** Compose the app's settings layout and detail surface for each preview screen. */
export const PreviewPage = ({
  title,
  action,
  actionsClassName,
  search,
  panel,
  onClose,
  children,
}: {
  title: string
  action?: ReactNode
  actionsClassName?: string
  search?: { placeholder: string; label: string; onSearch: (value: string) => void }
  panel?: ReactNode
  onClose: () => void
  children: ReactNode
}) => {
  const header = (
    <PageHeader title={title} actionsClassName={actionsClassName}>
      {search && <PageSearch.Button />}
      {action}
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
          <SettingsListBody className={settingsListBodyRowsClass}>{children}</SettingsListBody>
        </SettingsListPane>
      </div>
      <DetailPanelSurface open={!!panel} onClose={onClose}>
        {panel}
      </DetailPanelSurface>
    </div>
  )
}
