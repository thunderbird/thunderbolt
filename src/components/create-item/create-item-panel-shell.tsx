/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { ReactNode } from 'react'

import { DetailPanel, DetailPanelSurface } from '@/components/detail-panel'
import { createItemTitles, type CreateItemRequest } from './context'

type CreateItemPanelShellProps = {
  kind: CreateItemRequest['kind']
  open: boolean
  onClose: () => void
  onCloseComplete: () => void
  children: ReactNode
}

/**
 * Shared chrome for the quick-create panels: the sliding `DetailPanelSurface`
 * plus a `DetailPanel` titled from `createItemTitles`, so every kind (and the
 * host's loading fallback) presents the same header and close behavior.
 */
export const CreateItemPanelShell = ({ kind, open, onClose, onCloseComplete, children }: CreateItemPanelShellProps) => (
  <DetailPanelSurface open={open} onClose={onClose} onCloseComplete={onCloseComplete} topInset>
    <DetailPanel title={createItemTitles[kind]} onClose={onClose}>
      {children}
    </DetailPanel>
  </DetailPanelSurface>
)
