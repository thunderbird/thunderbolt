/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { MessageDescriptor } from '@lingui/core'
import { useLingui } from '@lingui/react/macro'
import { Loader2 } from 'lucide-react'
import type { ReactNode } from 'react'

import { DetailPanel, DetailPanelSurface } from '@/components/detail-panel'
import { createItemTitles, type CreateItemRequest } from './context'

type CreateItemPanelShellProps = {
  kind: CreateItemRequest['kind']
  title?: MessageDescriptor
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
export const CreateItemPanelShell = ({
  kind,
  title = createItemTitles[kind],
  open,
  onClose,
  onCloseComplete,
  children,
}: CreateItemPanelShellProps) => {
  const { i18n } = useLingui()

  return (
    <DetailPanelSurface open={open} onClose={onClose} onCloseComplete={onCloseComplete} topInset>
      <DetailPanel title={i18n._(title)} onClose={onClose}>
        {children}
      </DetailPanel>
    </DetailPanelSurface>
  )
}

/**
 * The shell with a centered spinner body — shared by the host's Suspense
 * fallback and panels that are still loading the data they edit.
 */
export const CreateItemLoadingPanel = (props: Omit<CreateItemPanelShellProps, 'children'>) => (
  <CreateItemPanelShell {...props}>
    <div className="flex flex-1 items-center justify-center">
      <Loader2 className="size-[var(--icon-size-default)] animate-spin text-muted-foreground" />
    </div>
  </CreateItemPanelShell>
)
