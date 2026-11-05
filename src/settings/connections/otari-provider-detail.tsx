/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Trans, useLingui } from '@lingui/react/macro'
import { Link } from 'react-router'
import { DetailPanel, DetailSectionTitle } from '@/components/detail-panel'
import { OtariConnection } from '@/components/otari-connection'
import { ProviderBrandLogo } from '@/components/provider-brand-logo'
import { Button } from '@/components/ui/button'
import type { AiProviderConnection } from './types'

export const OtariProviderDetail = ({
  connection,
  pending,
  error,
  onClose,
  onDisconnect,
}: {
  connection: AiProviderConnection
  pending: boolean
  error: string | null
  onClose: () => void
  onDisconnect: () => void
}) => {
  const { t } = useLingui()
  return (
    <DetailPanel title={t`Otari`} icon={<ProviderBrandLogo provider="otari" />} onClose={onClose}>
      <div className="flex flex-col gap-3">
        <DetailSectionTitle>
          <Trans>Account</Trans>
        </DetailSectionTitle>
        {connection.connected ? (
          <>
            <p className="text-sm text-muted-foreground">
              <Trans>Connected</Trans>
            </p>
            <div className="flex flex-wrap gap-2">
              <Button asChild variant="outline" size="sm">
                <Link to="/settings/models">
                  <Trans>Manage models</Trans>
                </Link>
              </Button>
              <Button variant="outline" size="sm" disabled={pending} isLoading={pending} onClick={onDisconnect}>
                <Trans>Disconnect</Trans>
              </Button>
            </div>
          </>
        ) : (
          <OtariConnection context="connections" embedded onSaved={onClose} />
        )}
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
      </div>
    </DetailPanel>
  )
}
