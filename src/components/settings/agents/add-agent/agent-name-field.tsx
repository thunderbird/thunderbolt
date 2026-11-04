/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useId } from 'react'
import { Trans, useLingui } from '@lingui/react/macro'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import type { AddAgentController } from './use-add-agent-state'

export const AgentNameField = ({ controller }: { controller: AddAgentController }) => {
  const { t } = useLingui()
  const id = useId()
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>
        <Trans>Name</Trans>
      </Label>
      <Input
        id={id}
        value={controller.draft.name}
        onChange={(event) => controller.edit({ name: event.target.value })}
        placeholder={controller.suggestionStatus === 'pending' ? t`Suggesting a name…` : t`Agent name`}
        autoComplete="off"
        maxLength={100}
      />
    </div>
  )
}
