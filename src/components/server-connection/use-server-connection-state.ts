/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useLingui } from '@lingui/react/macro'
import { useEffect, useRef, useState, useTransition } from 'react'
import { connectToServer, ServerVersionUnsupportedError } from '@/lib/server-connection'

/** Validates a server before changing the app's connection. */
export const useServerConnectionState = (onConnected?: () => void, connect = connectToServer) => {
  const { t } = useLingui()
  const [serverUrl, setServerUrl] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [isConnecting, startTransition] = useTransition()

  const pending = useRef<AbortController | null>(null)
  // Leaving the form cancels validation before it can select a server.
  useEffect(() => () => pending.current?.abort(), [])

  const submit = () => {
    pending.current?.abort()
    const controller = new AbortController()
    pending.current = controller
    setError(null)
    startTransition(async () => {
      try {
        await connect(serverUrl, undefined, controller.signal)
        if (!controller.signal.aborted) {
          onConnected?.()
        }
      } catch (cause) {
        if (controller.signal.aborted) {
          return
        }
        setError(
          cause instanceof ServerVersionUnsupportedError
            ? t`Update Thunderbolt before connecting to this server. You can continue using your local models.`
            : t`Couldn't connect to this Thunderbolt server. Check the address and try again.`,
        )
      }
    })
  }

  return { serverUrl, setServerUrl, error, isConnecting, submit }
}
