/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useEffect, useRef, useState } from 'react'
import { localAppController } from './local-app-controller'
import type { LocalAppStatus } from '@shared/local-app-protocol'

/** Follow a device-local app across restarts without replacing its page session. */
export const useLocalAppUrl = (
  appId: string | undefined,
  onError: (error: string | null) => void,
  controller: Pick<typeof localAppController, 'start' | 'subscribe'> = localAppController,
) => {
  const [preview, setPreview] = useState<{ url: string | null; generation: number }>({ url: null, generation: 0 })
  const previous = useRef<LocalAppStatus | null>(null)
  useEffect(() => {
    if (!appId) {
      return
    }
    const abort = new AbortController()
    const update = (status: LocalAppStatus) => {
      if (abort.signal.aborted || status.id !== appId) {
        return
      }
      if (status.status === 'ready' && status.url) {
        const alreadyReady = previous.current?.id === appId && previous.current.status === 'ready'
        setPreview((current) =>
          alreadyReady && current.url === status.url
            ? current
            : { url: status.url, generation: current.generation + 1 },
        )
        onError(null)
      } else if (status.status === 'failed') {
        setPreview((current) => ({ ...current, url: null }))
        onError(status.error ?? 'The local app stopped')
      }
      previous.current = status
    }
    const unsubscribe = controller.subscribe(update)
    void controller
      .start(appId, abort.signal)
      .then(update)
      .catch((error) => {
        if (!abort.signal.aborted) {
          onError(String(error))
        }
      })
    return () => {
      unsubscribe()
      abort.abort()
    }
  }, [appId, controller, onError])
  return preview
}
