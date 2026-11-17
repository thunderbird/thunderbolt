/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import {
  miniAppGuestMethods,
  miniAppHostMethods,
  miniAppProtocolMarker,
  miniAppProtocolVersion,
  type MiniAppTool,
} from '../shared/mini-app-protocol'

/**
 * A different origin from the frontend (another port), so the frame is cross-origin as it is in production. It stays
 * on the frontend's site on purpose: the dev server sends `Cross-Origin-Embedder-Policy: credentialless`, and
 * Playwright's Firefox cannot see a frame from another site under that header, so the spec could not read it.
 */
export const miniAppOrigin = 'http://localhost:4599'

/** Sent to the composer; the fake provider answers it by reading an email and handing its body to the app. */
export const miniAppTransferPrompt = 'Show my latest email in the open app.'
export const protectedEmailId = 'e2e-protected-message'
export const protectedEmailBody = 'Synthetic protected email body PROTECTED-7Q2X'

/** Declared read-only by the app. The approval prompt must appear anyway. */
export const miniAppTool = {
  name: 'show_note',
  description: 'Show a note in the app. Read-only.',
  inputSchema: { type: 'object', properties: { note: { type: 'string' } }, required: ['note'] },
  annotations: { readOnlyHint: true, title: 'Show a note' },
} satisfies MiniAppTool

export const miniAppToolsetName = `app_${miniAppTool.name}`

/**
 * The frame's document: a bare guest speaking the bridge protocol, which lists every note it receives so the
 * spec can see exactly what reached the app's origin.
 */
export const miniAppGuestHtml = (hostOrigin: string) => `<!doctype html>
<html>
  <body>
    <h1>Notes</h1>
    <ul id="received"></ul>
    <script>
      const host = ${JSON.stringify(hostOrigin)}
      const documentId = crypto.randomUUID()
      const post = (message) =>
        parent.postMessage({ jsonrpc: '2.0', protocol: ${JSON.stringify(miniAppProtocolMarker)}, ...message }, host)
      const replies = {
        ${JSON.stringify(miniAppHostMethods.identify)}: () => ({ documentId }),
        ${JSON.stringify(miniAppHostMethods.toolsList)}: () => ({ tools: [${JSON.stringify(miniAppTool)}] }),
        ${JSON.stringify(miniAppHostMethods.toolsCall)}: ({ arguments: args }) => {
          const item = document.createElement('li')
          item.textContent = args.note
          document.getElementById('received').append(item)
          return { content: 'Shown.' }
        },
      }
      addEventListener('message', ({ origin, source, data }) => {
        const reply = data?.protocol === ${JSON.stringify(miniAppProtocolMarker)} && replies[data.method]
        if (origin === host && source === parent && reply) post({ id: data.id, result: reply(data.params) })
      })
      post({
        id: 'initialize',
        method: ${JSON.stringify(miniAppGuestMethods.initialize)},
        params: {
          protocolVersion: ${miniAppProtocolVersion},
          appName: 'Notes',
          documentId,
          capabilities: { tools: true },
        },
      })
    </script>
  </body>
</html>`
