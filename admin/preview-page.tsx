/* UNLICENSED — license TBD. This file is not licensed under MPL-2.0.
 * All rights reserved. See admin/LICENSE.
 * Enterprise support and licensing: contact info@thunderbolt.io. */

import type { ReactNode } from 'react'
import { DetailPanelSurface } from '@/components/detail-panel'
import { SettingsListBody, SettingsListPane, settingsListBodyRowsClass } from '@/components/settings/settings-list'
import { PageHeader } from '@/components/ui/page-header'
import { PreviewResetAction } from './preview-reset-action'

/** Compose the app's settings layout and detail surface for each preview screen. */
export const PreviewPage = ({
  title,
  action,
  panel,
  onClose,
  onReset,
  children,
}: {
  title: string
  action?: ReactNode
  panel?: ReactNode
  onClose: () => void
  onReset: () => void
  children: ReactNode
}) => (
  <div className="relative flex h-full">
    <div className="min-w-0 flex-1 overflow-hidden">
      <SettingsListPane className="gap-6">
        <PageHeader title={title}>
          <PreviewResetAction onReset={onReset} />
          {action}
        </PageHeader>
        <SettingsListBody className={settingsListBodyRowsClass}>{children}</SettingsListBody>
      </SettingsListPane>
    </div>
    <DetailPanelSurface open={!!panel} onClose={onClose}>
      {panel}
    </DetailPanelSurface>
  </div>
)
