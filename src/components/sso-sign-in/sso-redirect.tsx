/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Trans } from '@lingui/react/macro'
import { useLocalSettingsStore } from '@/stores/local-settings-store'
import Loading from '@/loading'
import { AuthScreen, authButtonClass } from '@/components/auth-screen'
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
      <AuthScreen>
        <p className="text-center text-base text-muted-foreground">
          <Trans>
            Unable to connect to the identity provider. Check your network connection and SSO configuration.
          </Trans>
        </p>
        <div className="flex w-full flex-col gap-4">
          <Button onClick={actions.retry} className={authButtonClass}>
            <Trans>Try again</Trans>
          </Button>
          {localMode && (
            <Button variant="outline" onClick={() => window.location.replace('/')} className={authButtonClass}>
              <Trans>Continue locally</Trans>
            </Button>
          )}
        </div>
      </AuthScreen>
    )
  }

  return <Loading />
}

export default SsoRedirect
