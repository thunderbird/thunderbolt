/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { DetailDivider, DetailPanel, DetailSectionTitle } from '@/components/detail-panel'
import { AvailableTools, type ToolItem } from '@/components/available-tools'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { ConnectProviderButton } from '@/components/connect-provider-button'
import type { Integration } from './types'

/**
 * Slide-in detail panel for a pre-baked integration (Thunderbolt, Google,
 * Microsoft): account/connect state up top, the tool catalog below. Enable /
 * disable lives on the list row's switch, matching the skills page.
 */
export const IntegrationDetail = ({
  integration,
  tools,
  isProcessingCallback,
  error,
  onGetPro,
  onDisconnect,
  onError,
  onClose,
}: {
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
}) => {
  const isPro = integration.provider === 'thunderbolt-pro'

  return (
    <DetailPanel
      icon={<span className="flex size-6 shrink-0 items-center justify-center">{integration.icon}</span>}
      title={integration.name}
      subtitle={integration.isConnected ? integration.userEmail : undefined}
      onClose={onClose}
    >
      <div className="flex shrink-0 flex-col gap-2">
        <DetailSectionTitle>Account</DetailSectionTitle>
        {integration.isConnected ? (
          <div className="flex items-center justify-between gap-3">
            <p className="min-w-0 truncate text-base text-foreground">
              {integration.userEmail ?? `Connected to ${integration.name}`}
            </p>
            {!isPro && (
              <Button variant="outline" size="sm" onClick={onDisconnect}>
                Disconnect
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
            returnContext="integrations"
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
            Connect your account to make these tools available to agents.
          </p>
        )}
      </div>
    </DetailPanel>
  )
}
