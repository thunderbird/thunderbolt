/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Trans, useLingui } from '@lingui/react/macro'
import { Monitor, Sparkles } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { ProviderConnectionButton } from '@/components/provider-connection-button'
import { cn } from '@/lib/utils'
import { AddModelForm } from '@/settings/models/add-model-form'
import { OnboardingChoiceCard } from './onboarding-choice-card'
import { OnboardingActionButtons } from './onboarding-action-buttons'
import { OnboardingStepHeader } from './onboarding-step-header'
import { OnboardingProviderLogo } from './onboarding-provider-logo'
import { useOnboardingModelState } from './use-onboarding-model-state'
import { useOnboardingProviderState } from './use-onboarding-provider-state'

type OnboardingModelStepProps = { onBack?: () => void; onContinue?: () => void; onSkip?: () => void }

const OnboardingModelStep = ({ onBack, onContinue, onSkip }: OnboardingModelStepProps) => {
  const { t } = useLingui()
  const { connectedModels, isLoading, disconnectProvider } = useOnboardingModelState()
  const state = useOnboardingProviderState(
    connectedModels.map(({ provider }) => (provider === 'openrouter' || provider === 'tinfoil' ? provider : 'custom')),
    undefined,
    onContinue,
  )
  const busy = state.isConnecting || state.isDisconnecting || state.addForm.isPending
  const isConnectionStep = state.view === 'openrouter' || state.view === 'tinfoil'
  const providerName = state.provider === 'tinfoil' ? 'Tinfoil' : 'OpenRouter'
  const back = () => {
    if (state.view === 'choices') {
      onBack?.()
    } else if (state.view === 'manual' || (state.showApiKey && state.supportsSignIn)) {
      state.cancelConnection()
    } else {
      state.showChoices()
    }
  }

  return (
    <div className="flex min-h-0 w-full flex-1 flex-col">
      <div className="flex min-h-0 w-full flex-1 flex-col overflow-y-auto px-6 py-4">
        <div className={cn('flex flex-1 flex-col gap-5', state.view !== 'other' && 'justify-center')}>
          {state.view === 'choices' && (
            <>
              <OnboardingStepHeader
                icon={<Sparkles className="size-10 text-foreground/80" aria-hidden="true" />}
                title={<Trans>Connect your AI</Trans>}
                description={<Trans>Choose a provider to power your agents.</Trans>}
              />
              <fieldset aria-label={t`AI provider`} className="flex min-w-0 flex-col gap-2">
                <OnboardingChoiceCard
                  name="ai-provider"
                  value="openrouter"
                  label={t`OpenRouter`}
                  disabled={busy}
                  description={<Trans>Sign in to connect your account.</Trans>}
                  icon={<OnboardingProviderLogo provider="openrouter" />}
                  checked={state.selection === 'openrouter'}
                  onSelect={() => state.selectProvider('openrouter')}
                />
                <OnboardingChoiceCard
                  name="ai-provider"
                  value="tinfoil"
                  label={t`Tinfoil`}
                  disabled={busy}
                  description={<Trans>Sign in to connect your private AI.</Trans>}
                  icon={<OnboardingProviderLogo provider="tinfoil" />}
                  checked={state.selection === 'tinfoil'}
                  onSelect={() => state.selectProvider('tinfoil')}
                />
                <OnboardingChoiceCard
                  name="ai-provider"
                  value="custom"
                  label={t`Other provider`}
                  disabled={busy}
                  description={<Trans>Connect a local model or use an API key.</Trans>}
                  icon={<Monitor className="size-6" aria-hidden="true" />}
                  checked={state.selection === 'custom'}
                  onSelect={() => state.selectProvider('custom')}
                />
              </fieldset>
            </>
          )}
          {isConnectionStep && (
            <>
              <OnboardingStepHeader
                icon={<OnboardingProviderLogo provider={state.provider} className="size-10" />}
                title={<Trans>Connect {providerName}</Trans>}
                description={
                  state.supportsSignIn ? (
                    <Trans>Connect your account to power your agents.</Trans>
                  ) : (
                    <Trans>Use a Tinfoil API key to power your agents.</Trans>
                  )
                }
              />
              {state.provider === 'tinfoil' && !state.isConnected && !state.showApiKey && (
                <p className="text-center text-sm text-muted-foreground">
                  <Trans>Connect with a paid Tinfoil subscription.</Trans>
                </p>
              )}
              <div className="mx-auto mt-5 flex w-full max-w-xs flex-col gap-3">
                {state.showApiKey && !state.isConnected ? (
                  <form
                    className="flex flex-col gap-3"
                    onSubmit={(event) => {
                      event.preventDefault()
                      void state.connectApiKey()
                    }}
                  >
                    <Label htmlFor="provider-api-key">
                      <Trans>API Key</Trans>
                    </Label>
                    <Input
                      id="provider-api-key"
                      type="password"
                      autoComplete="off"
                      disabled={busy}
                      {...state.addForm.form.register('apiKey')}
                    />
                    <Button
                      type="submit"
                      disabled={busy || !state.addForm.form.watch('apiKey')?.trim()}
                      isLoading={busy}
                    >
                      <Trans>Connect</Trans>
                    </Button>
                    {state.supportsSignIn && (
                      <Button
                        type="button"
                        variant="link"
                        size="sm"
                        className="text-muted-foreground"
                        onClick={state.cancelConnection}
                        disabled={busy}
                      >
                        <Trans>Use sign-in instead</Trans>
                      </Button>
                    )}
                  </form>
                ) : (
                  <>
                    <ProviderConnectionButton
                      isConnected={state.isConnected}
                      isProcessing={busy || isLoading}
                      connectLabel={t`Connect ${providerName}`}
                      connectedLabel={t`Connected`}
                      connectingLabel={state.isDisconnecting ? t`Disconnecting…` : t`Connecting…`}
                      onConnect={state.connectSelectedProvider}
                      onDisconnect={() => state.disconnectProvider(() => disconnectProvider(state.provider))}
                      className="w-full"
                    />
                    <div className="flex min-h-[var(--touch-height-sm)] justify-center">
                      {state.isConnecting && !state.addForm.isPending ? (
                        <Button variant="ghost" size="sm" onClick={state.cancelConnection}>
                          <Trans>Cancel connection</Trans>
                        </Button>
                      ) : (
                        !state.isConnected &&
                        !busy && (
                          <Button
                            variant="link"
                            size="sm"
                            className="text-sm font-normal text-muted-foreground"
                            onClick={state.useApiKey}
                          >
                            <Trans>Use an API key instead</Trans>
                          </Button>
                        )
                      )}
                    </div>
                  </>
                )}
                {state.showApiKey && state.isConnecting && !state.addForm.isPending && (
                  <Button variant="ghost" size="sm" onClick={state.cancelConnection}>
                    <Trans>Cancel connection</Trans>
                  </Button>
                )}
              </div>
            </>
          )}
          {state.view === 'manual' && (
            <>
              <OnboardingStepHeader
                icon={<OnboardingProviderLogo provider={state.provider} className="size-10" />}
                title={<Trans>Connect {providerName}</Trans>}
                description={<Trans>Finish connecting in your browser, then paste the authorization code here.</Trans>}
              />
              <div className="flex flex-col gap-3">
                <Label htmlFor="provider-code">
                  <Trans>Authorization code</Trans>
                </Label>
                <Input
                  id="provider-code"
                  value={state.code}
                  onChange={(event) => state.setCode(event.target.value)}
                  autoComplete="off"
                  disabled={busy}
                />
                <Button onClick={state.submitCode} disabled={!state.code.trim() || busy} isLoading={busy}>
                  <Trans>Connect {providerName}</Trans>
                </Button>
                <Button variant="ghost" onClick={state.cancelConnection}>
                  <Trans>Cancel connection</Trans>
                </Button>
              </div>
            </>
          )}
          {state.view === 'other' && (
            <>
              <OnboardingStepHeader title={<Trans>Add a model</Trans>} />
              <AddModelForm {...state.addForm} showCancel={false} />
            </>
          )}
          {state.error && (
            <p role="alert" className="text-sm text-destructive">
              {state.error}
            </p>
          )}
        </div>
      </div>
      <div className="relative flex w-full shrink-0 px-5 pt-2">
        <OnboardingActionButtons
          onBack={back}
          onContinue={state.continueSelection}
          onSkip={() => {
            state.cancelConnection()
            onSkip?.()
          }}
          showBack
          showSkip={Boolean(onSkip)}
          skipDisabled={state.isDisconnecting || state.addForm.isPending}
          showContinue={state.view === 'choices' || isConnectionStep}
          backDisabled={busy}
          continueDisabled={busy || isLoading || (isConnectionStep && !state.isConnected)}
        />
      </div>
    </div>
  )
}

export default OnboardingModelStep
