/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Trans, useLingui } from '@lingui/react/macro'
import { useId } from 'react'

import { Switch } from '@/components/ui/switch'

type SupportsToolsSwitchProps = {
  checked: boolean
  onCheckedChange: (checked: boolean) => void
  /** Locked while a connection test runs, since its result overwrites the switch. */
  disabled?: boolean
}

/** Model-form switch for whether chats send tool definitions to the model. */
export const SupportsToolsSwitch = ({ checked, onCheckedChange, disabled }: SupportsToolsSwitchProps) => {
  const { t } = useLingui()
  const descriptionId = useId()

  return (
    <div className="flex items-center gap-4">
      <div className="flex-1">
        <p className="text-sm font-medium">
          <Trans>Supports tools</Trans>
        </p>
        <p id={descriptionId} className="text-sm text-muted-foreground">
          <Trans>
            Lets the model call tools like web search and integrations. Turn this off if the model rejects tool
            requests.
          </Trans>
        </p>
      </div>
      <Switch
        checked={checked}
        onCheckedChange={onCheckedChange}
        disabled={disabled}
        aria-label={t`Supports tools`}
        aria-describedby={descriptionId}
      />
    </div>
  )
}
