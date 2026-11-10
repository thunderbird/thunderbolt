/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { parseHarnessMessage, type HarnessMessage, type HarnessRequest } from './harness-protocol'

/** Bind one guest-created port to this render, without sending capabilities to a navigable WindowProxy. */
export const bindArtifactChannel = ({
  getFrameWindow,
  nonce,
  onMessage,
  onClose,
}: {
  getFrameWindow: () => Window | null
  nonce: string
  onMessage: (message: HarnessMessage) => void
  onClose?: () => void
}) => {
  let port: MessagePort | undefined
  let closed = false
  const close = () => {
    if (closed) {
      return
    }
    closed = true
    window.removeEventListener('message', bootstrap)
    if (port) {
      port.onmessage = null
      port.close()
    }
    onClose?.()
  }
  const bootstrap = (event: MessageEvent) => {
    const frameWindow = getFrameWindow()
    if (
      !frameWindow ||
      event.source !== frameWindow ||
      event.data?.type !== 'artifact-connect' ||
      event.data.artifactNonce !== nonce
    ) {
      return
    }
    if (closed || port || event.ports.length !== 1) {
      event.ports.forEach((duplicate) => duplicate.close())
      return
    }
    port = event.ports[0]
    port.onmessage = (reply: MessageEvent) => {
      if (closed) {
        return
      }
      const message = parseHarnessMessage(reply.data, nonce)
      if (message?.type === 'artifact-disconnect') {
        close()
      } else if (message) {
        onMessage(message)
      }
    }
  }
  window.addEventListener('message', bootstrap)
  return {
    send: (request: HarnessRequest) => {
      if (closed || !port) {
        throw new Error('The page document changed. Observe it again.')
      }
      port.postMessage(request)
    },
    close,
  }
}
