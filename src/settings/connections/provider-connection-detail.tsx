/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useRef, useState } from 'react'
import { Trans, useLingui } from '@lingui/react/macro'
import { SquarePen, Trash2 } from 'lucide-react'
import { DetailPanel } from '@/components/detail-panel'
import { DetailActionsMenu } from '@/components/settings/detail-actions-menu'
import { ConfirmActionDialog } from '@/components/ui/confirm-action-dialog'
import { ConnectionSetupFooter } from './connection-setup-footer'
import { Button } from '@/components/ui/button'
import { DropdownMenuItem } from '@/components/ui/dropdown-menu'
import type { ProviderConnection } from '@/providers/types'
import type { useProviderAuthorization } from '@/providers/use-provider-authorization'
import { ProviderConnectionIcon } from './provider-connection-icon'
import { ProviderConnectionForm } from './provider-connection-form'
import { ProviderConnectionButton } from '@/components/provider-connection-button'
import { ChatGPTAccountPicker } from './chatgpt-account-picker'
import { canConnectChatGPT } from '@/providers/chatgpt-auth'
import { ProviderConnectionSummary } from './provider-connection-summary'
import type { useAiProviderConnections } from './use-ai-provider-connections'
import { openExternalUrl } from '@/lib/open-external-url'
import { tinfoilManageSubscriptionUrl } from '@/lib/tinfoil-auth'

/** A durable connection stays visible when this device has no credentials. */
export const ProviderConnectionDetail = ({
  initialAction,
  connection,
  controls,
  authorization,
  onClose,
  onBack,
  onAddApiKey,
}: {
  initialAction?: 'edit' | 'remove'
  connection: ProviderConnection
  controls: ReturnType<typeof useAiProviderConnections>
  authorization: Omit<ReturnType<typeof useProviderAuthorization>, 'processMcpCallback'>
  onClose: () => void
  onBack?: () => void
  onAddApiKey?: () => void
}) => {
  const { t } = useLingui()
  const openingEditor = useRef(false)
  const hasSession = connection.connected || Boolean(connection.needsConsent)
  const [confirmRemoval, setConfirmRemoval] = useState(initialAction === 'remove')
  const [editor, setEditor] = useState<{
    hasSession: boolean
    mode: 'details' | 'edit' | 'connect'
  }>({
    hasSession,
    mode: initialAction === 'edit' ? 'edit' : hasSession ? 'details' : 'connect',
  })
  if (editor.hasSession !== hasSession) {
    setEditor({
      hasSession,
      mode: hasSession ? editor.mode : 'connect',
    })
  }
  // A reconnect publishes credentials before its discovery and refresh finish.
  // Keep its form mounted until onSaved, even when the live row becomes connected.
  const showForm = !hasSession || editor.mode !== 'details'
  const setMode = (mode: typeof editor.mode) => setEditor({ hasSession, mode })
  return (
    <DetailPanel
      title={connection.name}
      icon={<ProviderConnectionIcon provider={connection.provider} />}
      actions={
        <DetailActionsMenu
          onCloseAutoFocus={(event) => {
            if (openingEditor.current) {
              event.preventDefault()
              openingEditor.current = false
              // Mount the form after the menu releases focus so its autofocus can succeed.
              setMode('edit')
            }
          }}
        >
          {!showForm && (
            <DropdownMenuItem
              disabled={controls.pending}
              onClick={() => {
                openingEditor.current = true
              }}
            >
              <SquarePen />
              <Trans>Edit</Trans>
            </DropdownMenuItem>
          )}
          <DropdownMenuItem
            disabled={controls.pending || authorization.isPending}
            onClick={() => setConfirmRemoval(true)}
          >
            <Trash2 />
            <Trans>Remove connection</Trans>
          </DropdownMenuItem>
        </DetailActionsMenu>
      }
      onClose={onClose}
    >
      {showForm ? (
        <>
          {!hasSession && (
            <p className="text-sm text-muted-foreground">
              <Trans>Connect on this device</Trans>
            </p>
          )}
          <ProviderConnectionForm
            onBack={editor.mode !== 'edit' ? onBack : undefined}
            onAddApiKey={onAddApiKey}
            mode={editor.mode === 'edit' ? 'edit' : 'connect'}
            provider={connection.provider}
            connection={connection}
            authorization={authorization}
            onSaved={() => setMode('details')}
            onCancel={() => (hasSession ? setMode('details') : onClose())}
          />
        </>
      ) : (
        <ProviderConnectionSummary
          connection={connection}
          onAddApiKey={connection.authMethod === 'oauth' ? onAddApiKey : undefined}
        >
          {connection.needsConsent && (
            <ProviderConnectionButton
              isConnected={false}
              isProcessing={authorization.isPending}
              connectLabel={t`Allow plan access`}
              disabled={controls.pending}
              onConnect={() =>
                authorization.authorize({ provider: 'openai', id: connection.id, name: connection.name })
              }
              onCancel={authorization.cancel}
            />
          )}
          {authorization.error && (
            <p role="alert" className="text-sm text-destructive">
              {authorization.error}
            </p>
          )}
          {connection.provider === 'openai' && connection.authMethod === 'oauth' && canConnectChatGPT() && (
            <ChatGPTAccountPicker
              isPending={authorization.isPending && !connection.needsConsent}
              disabled={controls.pending || authorization.isPending}
              onCancel={authorization.cancel}
              onChoose={(chatGPTAccountId) =>
                authorization.authorize({
                  provider: 'openai',
                  id: connection.id,
                  name: connection.name,
                  chatGPTAccountId,
                })
              }
            />
          )}
          <Button
            variant="outline"
            size="sm"
            onClick={() => controls.disconnect(connection.id)}
            disabled={controls.pending || authorization.isPending}
          >
            <Trans>Disconnect this device</Trans>
          </Button>
          {connection.provider === 'tinfoil' && connection.authMethod === 'oauth' && (
            <Button
              variant="link"
              className="px-0 text-xs font-normal text-muted-foreground"
              onClick={() => openExternalUrl(tinfoilManageSubscriptionUrl)}
            >
              <Trans>Manage subscription</Trans>
            </Button>
          )}
        </ProviderConnectionSummary>
      )}
      {!showForm && onBack && (
        <ConnectionSetupFooter onBack={onBack} onContinue={onClose} ready={connection.connected && !controls.pending} />
      )}
      <ConfirmActionDialog
        open={confirmRemoval}
        title={t`Remove ${connection.name}?`}
        description={t`This removes the connection from your devices. Models and search using it will become unavailable. Your chat history will be kept.`}
        confirmLabel={t`Remove connection`}
        onCancel={() => setConfirmRemoval(false)}
        onConfirm={() => {
          setConfirmRemoval(false)
          authorization.cancel()
          controls.remove(connection.id, onClose)
        }}
      />
      {controls.error && (
        <p role="alert" className="text-sm text-destructive">
          {controls.error}
        </p>
      )}
    </DetailPanel>
  )
}
