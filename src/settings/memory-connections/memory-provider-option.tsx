/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { ReactNode } from 'react'
import { Trans, useLingui } from '@lingui/react/macro'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

type MemoryProviderOptionProps = {
  id: string
  name: string
  subtitle: string
  icon: ReactNode
  selected: boolean
  disabled: boolean
  onSelect: (id: string) => void
  onManage?: () => void
}

export const MemoryProviderOption = ({
  id,
  name,
  subtitle,
  icon,
  selected,
  disabled,
  onSelect,
  onManage,
}: MemoryProviderOptionProps) => {
  const { t } = useLingui()
  return (
    <div className={cn('flex items-center pr-3', selected && 'bg-accent/40')}>
      <label className="flex min-w-0 flex-1 cursor-pointer items-center gap-3 p-4 has-[:disabled]:cursor-default">
        <span className="relative size-4 shrink-0">
          <input
            type="radio"
            name="memory-provider"
            value={id}
            checked={selected}
            disabled={disabled}
            onChange={() => onSelect(id)}
            aria-label={name}
            className="m-0 block size-4 cursor-pointer appearance-none rounded-full border border-border-strong bg-background checked:border-transparent checked:bg-brand checked:bg-origin-border checked:[background-image:var(--gradient-brand)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:cursor-not-allowed forced-colors:appearance-auto"
          />
          {selected && (
            <span
              aria-hidden="true"
              className="pointer-events-none absolute left-1/2 top-1/2 size-1.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-brand-foreground forced-colors:hidden"
            />
          )}
        </span>
        <span className="flex size-8 shrink-0 items-center justify-center">{icon}</span>
        <span className="min-w-0">
          <span className="block truncate text-sm font-medium">{name}</span>
          <span className="block text-xs text-muted-foreground">{subtitle}</span>
        </span>
      </label>
      {onManage && (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          aria-label={t`Manage ${name}`}
          onClick={onManage}
          disabled={disabled}
        >
          <Trans>Manage</Trans>
        </Button>
      )}
    </div>
  )
}
