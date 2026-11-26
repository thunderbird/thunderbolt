/* UNLICENSED — license TBD. This file is not licensed under MPL-2.0.
 * All rights reserved. See admin/LICENSE.
 * Enterprise support and licensing: contact info@thunderbolt.io. */

import type { ReactNode } from 'react'
import { DetailPanelSurface } from '@/components/detail-panel'
import { SettingsListBody, SettingsListPane } from '@/components/settings/settings-list'
import { PageHeader } from '@/components/ui/page-header'
import { PageSearch } from '@/components/ui/page-search'

type AdminPageProps = {
  title: string
  /** Beside the title, as Skills' header holds its create action; on phones each control places itself. */
  action?: ReactNode
  actionsClassName?: string
  search?: { placeholder: string; onSearch: (value: string) => void; defaultValue?: string }
  /** Nothing to list yet: the header drops its search and actions, and the empty state offers what to do. */
  isEmpty?: boolean
  /** The detail panel beside the list; pass `onClose` with it. */
  panel?: ReactNode
  onClose?: () => void
  children?: ReactNode
}

/** The settings list layout, header and detail surface, shared by every admin screen. */
export const AdminPage = ({
  title,
  action,
  actionsClassName,
  search: searchProp,
  isEmpty = false,
  panel,
  onClose,
  children,
}: AdminPageProps) => {
  const search = isEmpty ? undefined : searchProp
  const header = (
    <PageHeader title={title} actionsClassName={actionsClassName}>
      {search && <PageSearch.Button />}
      {!isEmpty && action}
    </PageHeader>
  )
  return (
    <div className="relative flex h-full">
      <div className="min-w-0 flex-1 overflow-hidden">
        {/* The Skills page's shell, spacing included. */}
        <SettingsListPane>
          {search ? (
            <PageSearch onSearch={search.onSearch} defaultValue={search.defaultValue}>
              {header}
              <PageSearch.Input placeholder={search.placeholder} onSearch={search.onSearch} />
            </PageSearch>
          ) : (
            header
          )}
          <SettingsListBody>{children}</SettingsListBody>
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
