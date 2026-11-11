/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useId } from 'react'
import { useNavigate } from 'react-router'
import { Trans } from '@lingui/react/macro'
import { AppLogo } from '@/components/app-logo'
import { Button } from '@/components/ui/button'
import { useCreateItem } from '@/components/create-item/context'

/** Empty chat setup with direct actions for connecting a provider or adding a model. */
export const ChatModelSetup = () => {
  const titleId = useId()
  const descriptionId = useId()
  const navigate = useNavigate()
  const { openCreateItem } = useCreateItem()

  return (
    <section
      aria-labelledby={titleId}
      aria-describedby={descriptionId}
      className="my-auto flex w-full max-w-md flex-col items-center px-4 py-8 text-center"
    >
      <AppLogo size={64} />
      <h2 id={titleId} className="mt-5 text-2xl font-semibold text-foreground">
        <Trans>Connect your AI</Trans>
      </h2>
      <p id={descriptionId} className="mt-3 text-base leading-relaxed text-muted-foreground">
        <Trans>Connect a model provider or add your own model to start chatting.</Trans>
      </p>
      <div className="mt-8 grid w-full grid-cols-2 gap-3">
        <Button variant="secondary" className="w-full" onClick={() => openCreateItem({ kind: 'model' })}>
          <Trans>Add a model</Trans>
        </Button>
        <Button className="w-full" onClick={() => navigate('/settings/connections')}>
          <Trans>Connect a provider</Trans>
        </Button>
      </div>
    </section>
  )
}
