/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Trans } from '@lingui/react/macro'
import { Button } from '@/components/ui/button'
import { responseHeadingId } from './latest-response'

type GoToLatestResponseButtonProps = {
  messageId: string
}

/**
 * A skip link to the newest response, placed just before the composer so
 * Shift+Tab from the text box reaches it. Visually hidden until it has focus.
 * Focus moves only when the user activates it, never on its own.
 */
export const GoToLatestResponseButton = ({ messageId }: GoToLatestResponseButtonProps) => (
  <div className="sr-only focus-within:not-sr-only focus-within:absolute focus-within:bottom-full focus-within:left-1/2 focus-within:z-20 focus-within:mb-2 focus-within:-translate-x-1/2">
    <Button
      variant="outline"
      size="sm"
      className="shadow-md"
      onClick={() => document.getElementById(responseHeadingId(messageId))?.focus()}
    >
      <Trans>Go to latest response</Trans>
    </Button>
  </div>
)
