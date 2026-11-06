/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useAuth } from '@/contexts'
import { useWaitlistState } from './use-waitlist-state'
import { WaitlistCard } from './waitlist-card'
import { WaitlistContent } from './waitlist-content'

/** Unified early-access entry point; approved users sign in through the same form. */
export const WaitlistPage = () => {
  const authClient = useAuth()
  const waitlist = useWaitlistState({ authClient })

  return (
    <WaitlistCard>
      <WaitlistContent waitlist={waitlist} />
    </WaitlistCard>
  )
}

export default WaitlistPage
