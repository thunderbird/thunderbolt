/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Trans, useLingui } from '@lingui/react/macro'
import { Search } from 'lucide-react'
import { ProviderConnectionForm } from '@/settings/connections/provider-connection-form'
import { ProviderConnectionSummary } from '@/settings/connections/provider-connection-summary'
import { ProviderConnectionIcon } from '@/settings/connections/provider-connection-icon'
import { Button } from '@/components/ui/button'
import { OnboardingStepHeader } from './onboarding-step-header'
import { OnboardingChoiceCard } from './onboarding-choice-card'
import { OnboardingActionButtons } from './onboarding-action-buttons'
import { canSupplySearch } from '@/integrations/standalone-search/eligibility'
import { useOnboardingSearchState, type OnboardingSearchStepProps } from './use-onboarding-search-state'

/** Provider choices and connection steps match model onboarding. */
export const OnboardingSearchStep = (props: OnboardingSearchStepProps) => {
  const { t } = useLingui()
  const { onBack, onSkip } = props
  const state = useOnboardingSearchState(props)
  const { stored, choices, connected, connectionControls, otariEnabled, provider, authorization, choose, back, saved } =
    state
  return (
    <div className="flex min-h-0 w-full flex-1 flex-col">
      <div className="flex min-h-0 w-full flex-1 flex-col overflow-y-auto px-6 py-4">
        <div className="flex flex-1 flex-col justify-center gap-5">
          <OnboardingStepHeader
            icon={<Search className="size-10 text-foreground/80" />}
            title={<Trans>Add web search</Trans>}
            description={<Trans>Optionally let your agent search the web</Trans>}
          />
          {state.view === 'choices' && (
            <>
              {otariEnabled && stored.connectionStatus && stored.connectionStatus.status !== 'available' && (
                <p role="status" className="text-center text-sm text-muted-foreground">
                  <Trans>Otari web search isn’t available. Choose a search provider below, or skip for now.</Trans>
                </p>
              )}
              <fieldset aria-label={t`Search provider`} className="flex flex-col gap-2">
                {choices.map((choice) => (
                  <OnboardingChoiceCard
                    key={choice.id}
                    name="search-provider"
                    value={choice.id}
                    label={choice.name}
                    accessibleLabel={choice.name}
                    description={
                      choice.connected && choice.provider !== 'exa' ? (
                        <Trans>Use this connection.</Trans>
                      ) : choice.provider === 'brave' ? (
                        <Trans>Connect with an API key.</Trans>
                      ) : (
                        <Trans>Sign in to connect your account.</Trans>
                      )
                    }
                    icon={
                      <span className="[&>svg]:size-6 [&>img]:size-6">
                        <ProviderConnectionIcon provider={choice.provider} />
                      </span>
                    }
                    checked={state.selection === choice.id}
                    onSelect={() => choose(choice.id)}
                  />
                ))}
              </fieldset>
            </>
          )}
          {state.view === 'connect' && provider && (
            <ProviderConnectionForm
              key={provider}
              hideName
              provider={provider}
              authorization={authorization}
              onBack={back}
              onSaved={saved}
              onCancel={back}
            />
          )}
          {state.view === 'ready' && connected && (
            <ProviderConnectionSummary connection={connected}>
              {!canSupplySearch(connected) && (
                <p className="text-sm text-muted-foreground">
                  <Trans>Connect or enable this connection to use search</Trans>
                </p>
              )}
              {connected.connected && connected.enabled === 0 && (
                <Button
                  onClick={() => connectionControls.toggle(connected.id, true)}
                  disabled={!connectionControls.ready || connectionControls.pending}
                  isLoading={connectionControls.pending}
                >
                  <Trans>Enable connection</Trans>
                </Button>
              )}
              {connectionControls.error && (
                <p role="alert" className="text-sm text-destructive">
                  {connectionControls.error}
                </p>
              )}
            </ProviderConnectionSummary>
          )}
        </div>
      </div>
      {state.view !== 'connect' && (
        <div className="relative flex w-full shrink-0 px-5 pt-2">
          <OnboardingActionButtons
            onBack={state.view === 'choices' ? onBack : back}
            onSkip={onSkip}
            onContinue={state.continueSetup}
            continueDisabled={!state.canContinue}
          />
        </div>
      )}
    </div>
  )
}
