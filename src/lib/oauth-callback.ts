/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Listens for an OAuth callback delivered via `postMessage` from a popup window.
 * Only accepts messages whose origin matches `window.location.origin` to prevent
 * cross-origin spoofing.
 */
export const waitForOAuthCallback = (
  popup: Window | null,
  eventTarget: EventTarget = window,
): Promise<{ code: string; state: string }> =>
  new Promise<{ code: string; state: string }>((resolve, reject) => {
    const cleanup = () => {
      eventTarget.removeEventListener('message', handler)
      clearTimeout(timeoutId)
    }

    const handler = (event: Event) => {
      const msg = event as MessageEvent
      if (msg.origin !== window.location.origin) {
        return
      }
      if (msg.data?.type === 'oauth-callback') {
        cleanup()
        if (popup && !popup.closed) {
          popup.close()
        }

        if (msg.data.error) {
          reject(new Error(msg.data.error))
        } else if (msg.data.code && msg.data.state) {
          resolve({ code: msg.data.code, state: msg.data.state })
        } else {
          reject(new Error('Invalid OAuth callback: missing code or state'))
        }
      }
    }

    eventTarget.addEventListener('message', handler)

    const timeoutId = setTimeout(
      () => {
        cleanup()
        reject(new Error('OAuth timeout - please try again'))
      },
      10 * 60 * 1000,
    )
  })
