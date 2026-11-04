/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Brain } from 'lucide-react'
import { Trans, useLingui } from '@lingui/react/macro'
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { useEffortSelectorState } from './use-effort-selector-state'

export const EffortSelector = () => {
  const { t } = useLingui()
  const { error, choices, value, busy, choose } = useEffortSelectorState()
  if (!choices.length) {
    return null
  }
  return (
    <>
      {error && (
        <span role="alert" className="text-destructive text-[length:var(--font-size-xs)]">
          {error}
        </span>
      )}
      <Select value={value} onValueChange={choose} disabled={busy}>
        <SelectTrigger
          aria-label={t`Reasoning effort`}
          title={t`Higher effort can improve difficult answers but takes more time and tokens.`}
          className="w-auto gap-1 border-0 bg-transparent shadow-none h-[var(--touch-height-control)]"
        >
          <Brain aria-hidden="true" className="size-[var(--icon-size-sm)]" />
          <SelectValue placeholder={t`Reasoning effort`} />
        </SelectTrigger>
        <SelectContent align="end">
          <SelectGroup>
            <SelectLabel>
              <Trans>Reasoning effort</Trans>
            </SelectLabel>
            {choices.map((choice) => (
              <SelectItem key={choice.value} value={choice.value}>
                {choice.name}
              </SelectItem>
            ))}
          </SelectGroup>
        </SelectContent>
      </Select>
    </>
  )
}
