/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useState } from 'react'
import { ConfirmActionDialog } from '@/components/ui/confirm-action-dialog'
import { useLocation } from 'react-router'
import { oauthReturnPath } from '@/lib/oauth-return-route'
import { Trans, useLingui } from '@lingui/react/macro'
import { DetailDivider, DetailPanel, DetailSectionTitle } from '@/components/detail-panel'
import { AvailableTools, type ToolItem } from '@/components/available-tools'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { ConnectionSetupFooter } from './connection-setup-footer'
import { Button } from '@/components/ui/button'
import { ConnectProviderButton } from '@/components/connect-provider-button'
import type { Integration } from './types'

/**
 * Slide-in detail panel for a pre-baked integration (Thunderbolt, Google,
 * Microsoft): account/connect state up top, the tool catalog below. Enable /
 * disable lives on the list row's switch, matching the skills page.
 */
export const IntegrationDetail = ({
  initialAction,
  integration,
  tools,
  isProcessingCallback,
  error,
  onGetPro,
  onDisconnect,
  onError,
  onClose,
  onBack,
}: {
  initialAction?: 'edit' | 'remove'
  integration: Integration
  tools: ToolItem[]
  /** True while a returned OAuth callback is still being exchanged. */
  isProcessingCallback: boolean
  /** Connect/disconnect failure to surface next to the account controls. */
  error?: string | null
  onGetPro: () => void
  onDisconnect: () => void
  onError: (error: Error) => void
  onClose: () => void
  onBack?: () => void
}) => {
  const { t } = useLingui()
  const location = useLocation()
  const [confirmRemoval, setConfirmRemoval] = useState(initialAction === 'remove')
  const integrationName = integration.name
  const isPro = integration.provider === 'thunderbolt-pro'

  return (
    <DetailPanel
      icon={<span className="flex size-6 shrink-0 items-center justify-center">{integration.icon}</span>}
      title={integration.name}
      subtitle={integration.isConnected ? integration.userEmail : undefined}
      onClose={onClose}
    >
      <ConfirmActionDialog
        open={confirmRemoval && !isPro && integration.isConnected}
        title={t`Remove ${integrationName}?`}
        description={t`This disconnects your account on this device. Its tools will no longer be available.`}
        confirmLabel={t`Remove`}
        onCancel={() => setConfirmRemoval(false)}
        onConfirm={() => {
          setConfirmRemoval(false)
          onDisconnect()
        }}
      />
      <div className="flex shrink-0 flex-col gap-2">
        <DetailSectionTitle>
          <Trans>Account</Trans>
        </DetailSectionTitle>
        {integration.isConnected ? (
          <div className="flex items-center justify-between gap-3">
            <p className="min-w-0 truncate text-base text-foreground">
              {integration.userEmail ?? t`Connected to ${integrationName}`}
            </p>
            {!isPro && (
              <Button variant="outline" size="sm" onClick={onDisconnect}>
                <Trans>Disconnect</Trans>
              </Button>
            )}
          </div>
        ) : integration.provider === 'thunderbolt-pro' ? (
          <Button onClick={onGetPro} className="w-full">
            {integration.connectLabel}
          </Button>
        ) : (
          <ConnectProviderButton
            provider={integration.provider}
            isConnected={false}
            isProcessing={isProcessingCallback}
            onError={onError}
            returnContext={oauthReturnPath(`${location.pathname}${location.search}${location.hash}`)}
            className="w-full"
            connectLabel={integration.connectLabel}
          />
        )}
        {error && (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
      </div>

      <DetailDivider />

      <div className="flex flex-col gap-2">
        <AvailableTools tools={tools} />
        {!integration.isConnected && (
          <p className="text-[length:var(--font-size-xs)] text-muted-foreground">
            <Trans>Connect your account to make these tools available to agents.</Trans>
          </p>
        )}
      </div>
      {onBack && (
        <ConnectionSetupFooter
          onBack={onBack}
          onContinue={onClose}
          ready={integration.isConnected && !isProcessingCallback}
        />
      )}
    </DetailPanel>
  )
}
