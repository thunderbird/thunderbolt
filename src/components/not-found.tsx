/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { AppWordmark } from '@/components/app-wordmark'
import { Button } from '@/components/ui/button'
import { Trans } from '@lingui/react/macro'
import { useNavigate } from 'react-router'

export const NotFound = () => {
  const navigate = useNavigate()

  return (
    <div className="flex flex-col items-center justify-center w-full h-dvh">
      <div className="flex flex-col items-center gap-8 text-center">
        <AppWordmark />

        <h1 className="text-4xl font-semibold tracking-tight">
          <Trans>Not Found</Trans>
        </h1>

        <Button variant="secondary" onClick={() => navigate('/chats/new', { replace: true })}>
          <Trans>Back to App</Trans>
        </Button>
      </div>
    </div>
  )
}

export default NotFound
