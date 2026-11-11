/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useId } from 'react'
import { useCreateItem } from '@/components/create-item/context'
import { Trans } from '@lingui/react/macro'
import { AppLogo } from '@/components/app-logo'
import { Button } from '@/components/ui/button'

/** Empty chat setup with a direct entry point to the connection picker. */
export const ChatModelSetup = () => {
  const titleId = useId()
  const { openCreateItem } = useCreateItem()

  return (
    <section
      aria-labelledby={titleId}
      className="my-auto flex w-full max-w-md flex-col items-center px-4 py-8 text-center"
    >
      <AppLogo size={64} />
      <h2 id={titleId} className="mt-5 text-2xl font-semibold text-foreground">
        <Trans>Connect your AI</Trans>
      </h2>
      <Button className="mt-8" onClick={() => openCreateItem({ kind: 'connection' })}>
        <Trans>Add connection</Trans>
      </Button>
    </section>
  )
}
