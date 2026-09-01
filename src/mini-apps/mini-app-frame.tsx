/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { RefObject } from 'react'

import { EmbeddedSurfaceStatus } from '@/components/embedded/surface-status'
import type { MiniAppBridgeStatus } from './use-mini-app-bridge'
import type { MiniAppDefinition } from './registry'

type MiniAppFrameProps = {
  app: MiniAppDefinition
  frameRef: RefObject<HTMLIFrameElement | null>
  status: MiniAppBridgeStatus
}

/**
 * The embedded app itself.
 *
 * **On `allow-same-origin` next to `allow-scripts`:** `src/artifacts/verify-html.ts`
 * warns never to combine the two, and that warning is correct *there* — artifact
 * HTML is injected via `srcdoc`, so granting same-origin would give agent-written
 * code Thunderbolt's own origin and full access to our storage and cookies. A mini
 * app is loaded from a different origin over the network, so `allow-same-origin`
 * grants it nothing but *its own* origin, which it needs for storage, cookies and
 * same-origin fetches. Removing it here would break every real app; the pairing is
 * deliberate.
 */
export const MiniAppFrame = ({ app, frameRef, status }: MiniAppFrameProps) => (
  <div className="relative flex-1 w-full overflow-hidden">
    <iframe
      ref={frameRef}
      src={app.url}
      title={app.name}
      className="w-full h-full border-0 bg-background"
      sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
      // No referrer and no ambient credentials: the app is identified by its
      // registry entry, not by whatever cookies the browser happens to hold.
      referrerPolicy="no-referrer"
      allow=""
    />
    {status !== 'ready' && (
      <EmbeddedSurfaceStatus
        name={app.name}
        failed={status !== 'connecting'}
        detail={
          <>
            Nothing completed the handshake at {app.url}. Check the app is running and that it allows this origin in its{' '}
            <code>frame-ancestors</code>.
          </>
        }
      />
    )}
  </div>
)
