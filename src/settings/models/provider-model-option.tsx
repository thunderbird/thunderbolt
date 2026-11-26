/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Trans } from '@lingui/react/macro'
import { memo } from 'react'
import { Checkbox } from '@/components/ui/checkbox'
import type { AvailableModel } from './model-catalog'
import { getModelDisplayName } from './model-display-name'

type ProviderModelOptionProps = {
  model: AvailableModel
  selected: boolean
  added: boolean
  disabled: boolean
  onToggle: (id: string) => void
}

/** Keep unchanged catalog rows out of selection and search updates. */
export const ProviderModelOption = memo(({ model, selected, added, disabled, onToggle }: ProviderModelOptionProps) => {
  const name = getModelDisplayName(model)
  return (
    <label className="flex cursor-pointer items-center gap-3 rounded-md p-3 hover:bg-accent">
      <Checkbox
        checked={added || selected}
        onCheckedChange={() => onToggle(model.id)}
        disabled={added || disabled}
        aria-label={name}
      />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm">{name}</span>
        <span className="block truncate text-xs text-muted-foreground">{model.id}</span>
      </span>
      {added && (
        <span className="shrink-0 text-xs text-muted-foreground">
          <Trans>Added</Trans>
        </span>
      )}
    </label>
  )
})
