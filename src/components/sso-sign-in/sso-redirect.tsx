/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Trans } from '@lingui/react/macro'
import { useLocalSettingsStore } from '@/stores/local-settings-store'
import Loading from '@/loading'
import { Button } from '@/components/ui/button'
import { SsoConnectionList } from './sso-connection-list'
import { SsoEmailStep } from './sso-email-step'
import { useSsoSignInState } from './use-sso-sign-in-state'

/**
 * In SSO mode (OIDC or SAML), sends unauthenticated users to their identity provider: straight
 * there with one SSO connection, through an email step and a choice of connection with several.
 */
const SsoRedirect = () => {
  const localMode = useLocalSettingsStore((s) => s.localMode)
  const { state, actions } = useSsoSignInState()

  if (state.status === 'email' || (state.status === 'discovering' && state.email)) {
    return (
      <SsoEmailStep
        email={state.email}
        pending={state.status === 'discovering'}
        onEmailChange={actions.setEmail}
        onSubmit={actions.submitEmail}
        onUseEmailCode={actions.goToEmailCode}
      />
    )
  }

  if (state.status === 'choose') {
    return (
      <SsoConnectionList
        connections={state.connections}
        onChoose={actions.chooseConnection}
        onUseEmailCode={actions.goToEmailCode}
      />
    )
  }

  if (state.status === 'error') {
    return (
      <div className="flex h-screen flex-col items-center justify-center gap-4 px-6 text-center">
        <p className="text-[length:var(--font-size-body)] text-muted-foreground">
          <Trans>
            Unable to connect to the identity provider. Check your network connection and SSO configuration.
          </Trans>
        </p>
        <button
          type="button"
          onClick={actions.retry}
          className="h-[var(--touch-height-default)] rounded-lg bg-primary px-4 text-[length:var(--font-size-body)] text-primary-foreground"
        >
          <Trans>Try again</Trans>
        </button>
        {localMode && (
          <Button variant="outline" onClick={() => window.location.replace('/')}>
            <Trans>Continue locally</Trans>
          </Button>
        )}
      </div>
    )
  }

  return <Loading />
}

export default SsoRedirect
