/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Trans, useLingui } from '@lingui/react/macro'
import { Building2, Cloud, LayoutGrid, Monitor, Server } from 'lucide-react'
import { useId } from 'react'
import { OnboardingChoiceCard } from './onboarding-choice-card'
import { ChangeServerButton } from '@/components/server-connection/change-server-button'
import { ServerConnectionForm } from '@/components/server-connection/server-connection-form'
import { Button } from '@/components/ui/button'
import { useLocalSettingsStore } from '@/stores/local-settings-store'
import { OnboardingStepHeader } from './onboarding-step-header'
import type { useOnboardingServerState } from './use-onboarding-server-state'
import { WaitlistContent } from '@/waitlist/waitlist-content'

type OnboardingServerStepProps = {
  serverState: ReturnType<typeof useOnboardingServerState>
  onSignIn: () => void
  onContinueLocal: () => void
  allowLocal?: boolean
}

export const OnboardingServerStep = ({
  serverState,
  onSignIn,
  onContinueLocal,
  allowLocal = true,
}: OnboardingServerStepProps) => {
  const { t } = useLingui()
  const errorId = useId()
  const cloudUrl = useLocalSettingsStore((state) => state.cloudUrl)
  const { showServerForm, showWaitlist, waitlist, selection, selectSetup, error, isConnecting } = serverState

  if (showWaitlist) {
    return <WaitlistContent waitlist={waitlist} embedded />
  }

  if (cloudUrl) {
    return (
      <div className="flex w-full flex-1 flex-col justify-center gap-6">
        <OnboardingStepHeader
          icon={<Server className="size-10 text-primary" />}
          title={<Trans>Connect your account</Trans>}
          description={<Trans>Sign in to access the services available on this server.</Trans>}
        />
        <div className="rounded-xl bg-muted p-4">
          <p className="text-sm text-muted-foreground">
            <Trans>Selected server</Trans>
          </p>
          <p className="break-all text-sm">{cloudUrl}</p>
        </div>
        <div className="flex flex-col gap-3">
          <Button onClick={onSignIn}>
            <Trans>Sign In</Trans>
          </Button>
          <Button variant="outline" onClick={onContinueLocal}>
            <Trans>Continue setup without signing in</Trans>
          </Button>
          <ChangeServerButton />
        </div>
        <p className="text-center text-sm text-muted-foreground">
          <Trans>Your local data stays on this device until you enable sync.</Trans>
        </p>
      </div>
    )
  }

  if (showServerForm) {
    return (
      <div className="flex w-full flex-1 flex-col justify-center gap-6">
        <OnboardingStepHeader
          icon={<Building2 className="size-10 text-primary" />}
          title={<Trans>Connect to your server</Trans>}
        />
        <ServerConnectionForm onConnected={onSignIn} />
      </div>
    )
  }

  return (
    <div className="flex w-full flex-1 flex-col justify-center gap-5">
      <OnboardingStepHeader
        icon={<LayoutGrid className="size-10 text-foreground/80" aria-hidden="true" />}
        title={allowLocal ? <Trans>Choose your setup</Trans> : <Trans>Connect your account</Trans>}
        description={
          allowLocal ? (
            <Trans>Choose how you use Thunderbolt.</Trans>
          ) : (
            <Trans>Sign in to sync your workspace and access more features.</Trans>
          )
        }
      />
      <fieldset
        disabled={isConnecting}
        aria-label={allowLocal ? t`Choose your setup` : t`Connect your account`}
        className="flex min-w-0 flex-col gap-2"
      >
        {(
          [
            {
              value: 'local',
              title: t`Local`,
              description: <Trans>Use your own API keys without a server.</Trans>,
              Icon: Monitor,
            },
            {
              value: 'cloud',
              title: t`Cloud`,
              description: <Trans>Encrypted syncing and AI hosted by Thunderbolt</Trans>,
              Icon: Cloud,
            },
            {
              value: 'enterprise',
              title: t`Enterprise`,
              description: <Trans>Connect to your organization's server.</Trans>,
              Icon: Building2,
            },
          ] as const
        )
          .filter(({ value }) => allowLocal || value !== 'local')
          .map(({ value, title, description, Icon }) => (
            <OnboardingChoiceCard
              key={value}
              name={`${errorId}-setup`}
              value={value}
              label={title}
              accessibleLabel={value === 'cloud' ? t`Cloud (Waitlist)` : title}
              description={description}
              icon={<Icon className="size-6" aria-hidden="true" />}
              checked={selection === value}
              onSelect={() => selectSetup(value)}
              badge={
                value === 'cloud' ? (
                  <span className="rounded-md border border-brand/20 bg-linear-to-r from-brand-2/15 to-brand/20 px-2 py-0.5 text-xs font-medium text-foreground dark:from-brand-2/30 dark:to-brand/35">
                    <Trans>Waitlist</Trans>
                  </span>
                ) : undefined
              }
            />
          ))}
      </fieldset>
      {error && (
        <p id={errorId} role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
    </div>
  )
}
