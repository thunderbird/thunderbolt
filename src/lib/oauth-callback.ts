/**
 * Listens for an OAuth callback delivered via `postMessage` from a popup window.
 * Only accepts messages whose origin matches `window.location.origin` to prevent
 * cross-origin spoofing.
 */
export const waitForOAuthCallback = (popup: Window | null): Promise<{ code: string; state: string }> =>
  new Promise<{ code: string; state: string }>((resolve, reject) => {
    const handler = (event: MessageEvent) => {
      if (event.origin !== window.location.origin) {
        return
      }
      if (event.data?.type === 'oauth-callback') {
        window.removeEventListener('message', handler)
        if (popup && !popup.closed) {
          popup.close()
        }

        if (event.data.error) {
          reject(new Error(event.data.error))
        } else {
          resolve({ code: event.data.code, state: event.data.state })
        }
      }
    }

    window.addEventListener('message', handler)

    setTimeout(
      () => {
        window.removeEventListener('message', handler)
        reject(new Error('OAuth timeout - please try again'))
      },
      10 * 60 * 1000,
    )
  })
