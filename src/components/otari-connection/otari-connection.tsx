/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Trans, useLingui } from '@lingui/react/macro'
import { ExternalLink } from 'lucide-react'
import { useId } from 'react'
import { OnboardingActionButtons } from '@/components/onboarding/onboarding-action-buttons'
import { OnboardingStepHeader } from '@/components/onboarding/onboarding-step-header'
import { OnboardingProviderLogo } from '@/components/onboarding/onboarding-provider-logo'
import { ProviderConnectionButton } from '@/components/provider-connection-button'
import { Button } from '@/components/ui/button'
import { Combobox } from '@/components/ui/combobox'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { cn } from '@/lib/utils'
import { getModelDisplayName } from '@/settings/models/model-display-name'
import { useOtariConnectionState } from './use-otari-connection-state'
import type { OtariReturnContext } from '@/lib/otari-browser-auth'

type Props = {
  onSaved?: () => void
  onboarding?: boolean
  onBack?: () => void
  onSkip?: () => void
  context?: OtariReturnContext
  embedded?: boolean
}

export const OtariConnection = ({ onSaved, onboarding = false, onBack, onSkip, context, embedded = false }: Props) => {
  const { t } = useLingui()
  const state = useOtariConnectionState(onSaved, undefined, context ?? (onboarding ? 'onboarding' : 'models'))
  const id = useId()
  const content = (
    <>
      {onboarding && (
        <OnboardingStepHeader
          icon={<OnboardingProviderLogo provider="otari" className="size-10" />}
          title={<Trans>Connect Otari</Trans>}
          description={
            state.isCustomUrl ? (
              <Trans>Connect to your Otari server.</Trans>
            ) : (
              <Trans>Connect to the official Otari server.</Trans>
            )
          }
        />
      )}
      <section
        className={cn(
          'flex flex-col gap-4',
          onboarding ? 'mx-auto mt-5 w-full max-w-sm' : !embedded && 'rounded-xl border p-5',
        )}
      >
        {!onboarding && !embedded && (
          <h2 className="font-semibold">
            <Trans>Connect Otari</Trans>
          </h2>
        )}
        {state.key ? (
          <>
            <ProviderConnectionButton
              isConnected
              isProcessing={state.operation === 'disconnect'}
              disabled={state.busy}
              onConnect={state.connect}
              onDisconnect={state.reconnect}
              connectLabel={t`Connect Otari`}
              connectedLabel={t`Connected to Otari`}
              connectingLabel={t`Disconnecting…`}
              className="w-full bg-secondary text-muted-foreground"
            />
            {state.models.length > 0 ? (
              <>
                <div className="flex flex-col gap-2">
                  <Label htmlFor={`${id}-model`}>
                    <Trans>Choose a model</Trans>
                  </Label>
                  <Combobox
                    id={`${id}-model`}
                    autoFocus
                    items={state.models.map((model) => ({
                      id: model.id,
                      label: getModelDisplayName(model),
                      description: model.id,
                    }))}
                    value={state.selected}
                    disabled={state.busy}
                    onValueChange={state.setSelected}
                    placeholder={t`Choose a model`}
                    searchPlaceholder={t`Search models…`}
                    emptyMessage={t`No models found.`}
                  />
                </div>
                {!onboarding && (
                  <ProviderConnectionButton
                    isConnected={false}
                    isProcessing={state.operation === 'save'}
                    disabled={!state.selected || (state.busy && state.operation !== 'save')}
                    onConnect={state.save}
                    onCancel={state.cancel}
                    connectLabel={t`Use this model`}
                    connectingLabel={t`Checking model…`}
                  />
                )}
              </>
            ) : state.modelsLoaded ? (
              <div className="flex flex-col items-center gap-3 rounded-xl border bg-muted/30 p-5 text-center">
                <div className="flex flex-col gap-1">
                  <h3 className="text-sm font-medium">
                    <Trans>No models available yet</Trans>
                  </h3>
                  <p className="text-sm text-muted-foreground">
                    <Trans>Add a provider in your Otari workspace, then refresh to choose a model.</Trans>
                  </p>
                </div>
                <Button asChild variant="outline" size="sm">
                  <a href={`${state.dashboard}#/organization/provider-keys`} target="_blank" rel="noopener noreferrer">
                    <Trans>Open Otari</Trans>
                    <ExternalLink className="ml-2 size-3.5" aria-hidden="true" />
                  </a>
                </Button>
              </div>
            ) : null}
            {state.searchStatus && state.searchStatus !== 'available' && (
              <p role="status" className="text-sm text-muted-foreground">
                {state.searchStatus === 'not_configured' ? (
                  <Trans>Web search isn’t set up in this Otari workspace.</Trans>
                ) : state.searchStatus === 'workspace_disabled' ? (
                  <Trans>Web search is disabled in this Otari workspace.</Trans>
                ) : (
                  <Trans>Couldn’t check whether this Otari workspace has web search.</Trans>
                )}{' '}
                {onboarding && <Trans>You can choose a search provider in the next step.</Trans>}
              </p>
            )}
            <ProviderConnectionButton
              isConnected={false}
              isProcessing={state.operation === 'models'}
              disabled={state.busy && state.operation !== 'models'}
              variant="ghost"
              size="sm"
              className="self-center font-normal text-muted-foreground"
              onConnect={state.connect}
              onCancel={state.cancel}
              connectLabel={t`Refresh models`}
              connectingLabel={t`Loading models…`}
            />
          </>
        ) : (
          <>
            {state.isCustomUrl && (
              <div className="flex flex-col gap-2">
                <Label htmlFor={`${id}-origin`}>
                  <Trans>Otari server URL</Trans>
                </Label>
                <Input
                  id={`${id}-origin`}
                  autoFocus
                  type="url"
                  autoComplete="url"
                  placeholder={t`https://otari.example.com`}
                  value={state.origin}
                  disabled={state.busy}
                  onChange={(event) => state.setOrigin(event.target.value)}
                />
              </div>
            )}
            <ProviderConnectionButton
              isConnected={false}
              isProcessing={state.busy}
              disabled={!state.origin.trim()}
              onConnect={state.connect}
              onCancel={state.cancel}
              connectLabel={t`Connect Otari`}
            />
            <Button
              variant="link"
              size="sm"
              className="self-center font-normal text-muted-foreground"
              disabled={state.busy}
              onClick={state.isCustomUrl ? state.useHosted : state.useCustomUrl}
            >
              {state.isCustomUrl ? <Trans>Use the official Otari server</Trans> : <Trans>Custom URL</Trans>}
            </Button>
          </>
        )}
        {state.error && (
          <p role="alert" className="text-sm text-destructive">
            {state.error}
          </p>
        )}
      </section>
    </>
  )

  if (!onboarding) {
    return content
  }
  return (
    <div className="flex min-h-0 w-full flex-1 flex-col">
      <div className="flex min-h-0 w-full flex-1 flex-col overflow-y-auto px-6 py-4">
        <div className="flex flex-1 flex-col justify-center gap-5">{content}</div>
      </div>
      <div className="relative flex w-full shrink-0 px-5 pt-2">
        <OnboardingActionButtons
          onBack={onBack}
          onSkip={() => {
            state.cancel()
            onSkip?.()
          }}
          onContinue={state.save}
          showSkip={Boolean(onSkip)}
          continueDisabled={state.busy || !state.key || !state.selected}
          continueText={state.operation === 'save' ? <Trans>Checking model…</Trans> : undefined}
          backDisabled={state.busy}
          skipDisabled={state.operation === 'save'}
        />
      </div>
    </div>
  )
}
