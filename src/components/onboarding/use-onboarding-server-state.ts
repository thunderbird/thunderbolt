/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useLingui } from '@lingui/react/macro'
import { useReducer, useTransition } from 'react'
import { useAuth } from '@/contexts'
import { thunderboltCloudUrl } from '@/lib/constants'
import {
  canChangeServer,
  connectToServer,
  disconnectUnclaimedServer,
  ServerVersionUnsupportedError,
} from '@/lib/server-connection'
import { useLocalSettingsStore } from '@/stores/local-settings-store'
import { useWaitlistState } from '@/waitlist/use-waitlist-state'

type SetupChoice = 'cloud' | 'local' | 'enterprise'
type SetupState = {
  selection: SetupChoice
  showServerForm: boolean
  error: string | null
}
const initialState: SetupState = { selection: 'local', showServerForm: false, error: null }

/** Owns setup substeps so the wizard's Back button follows the selected path. */
export const useOnboardingServerState = (
  connect = connectToServer,
  options: { initialSelection?: SetupChoice; onSignInSuccess?: () => void } = {},
) => {
  const { t } = useLingui()
  const authClient = useAuth()
  const waitlist = useWaitlistState({ authClient, onSuccess: options.onSignInSuccess })
  const cloudUrl = useLocalSettingsStore((state) => state.cloudUrl)
  const [{ selection, showServerForm, error }, update] = useReducer(
    (state: SetupState, patch: Partial<SetupState>) => ({ ...state, ...patch }),
    { ...initialState, selection: options.initialSelection ?? initialState.selection },
  )
  const setShowServerForm = (showServerForm: boolean) => update({ showServerForm })
  const selectSetup = (selection: SetupChoice) => update({ selection, error: null })
  const [isConnecting, startConnecting] = useTransition()
  const showWaitlist = cloudUrl === thunderboltCloudUrl
  const isBusy =
    isConnecting ||
    waitlist.state.status === 'joining' ||
    waitlist.state.status === 'verifying' ||
    waitlist.state.passkeyPending

  const connectCloud = () => {
    update({ error: null })
    startConnecting(async () => {
      try {
        await connect(thunderboltCloudUrl)
      } catch (cause) {
        update({
          error:
            cause instanceof ServerVersionUnsupportedError
              ? t`Update Thunderbolt to connect to Thunderbolt Cloud. You can still set up without a server.`
              : t`Couldn't reach Thunderbolt Cloud. Try again, or set up without a server for now.`,
        })
      }
    })
  }

  const isChoosingSetup = !cloudUrl && !showServerForm
  const continueSetup = (onContinueLocal: () => void) => {
    if (isBusy || !isChoosingSetup) {
      return
    }
    if (selection === 'cloud') {
      connectCloud()
    }
    if (selection === 'local') {
      onContinueLocal()
    }
    if (selection === 'enterprise') {
      setShowServerForm(true)
    }
  }

  /** Returns whether this subflow handled Back before the wizard changes steps. */
  const goBack = (): boolean => {
    if (isBusy) {
      return true
    }
    if (showWaitlist) {
      if (waitlist.state.status === 'checkEmail') {
        waitlist.actions.reset()
        return true
      }
      if (canChangeServer()) {
        disconnectUnclaimedServer()
        waitlist.actions.reset()
      }
      return true
    }
    if (showServerForm && !cloudUrl) {
      setShowServerForm(false)
      return true
    }
    return false
  }

  return {
    selection,
    selectSetup,
    isChoosingSetup,
    continueSetup,
    showServerForm,
    setShowServerForm,
    showWaitlist,
    waitlist,
    connectCloud,
    error,
    isConnecting,
    isBusy,
    goBack,
  }
}
