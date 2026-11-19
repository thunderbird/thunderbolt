/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useId, type ReactNode } from 'react'
import { cn } from '@/lib/utils'

type OnboardingChoiceCardProps = {
  name: string
  value: string
  label: string
  description: ReactNode
  icon: ReactNode
  badge?: ReactNode
  footer?: ReactNode
  disabled?: boolean
  accessibleLabel?: string
  checked: boolean
  onSelect: () => void
}

export const OnboardingChoiceCard = ({
  name,
  value,
  label,
  description,
  icon,
  badge,
  footer,
  disabled,
  accessibleLabel,
  checked,
  onSelect,
}: OnboardingChoiceCardProps) => {
  const descriptionId = useId()
  return (
    <div
      className={cn(
        'w-full rounded-xl border text-left ring-offset-background has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-brand/60 has-[:focus-visible]:ring-offset-2',
        checked ? 'border-primary/40 bg-primary/5' : 'border-input hover:bg-accent',
      )}
    >
      <label className="grid w-full cursor-pointer grid-cols-[auto_1fr_auto] items-center gap-x-6 gap-y-1 px-6 py-3 has-[:disabled]:cursor-default">
        <span className="row-span-2 text-muted-foreground max-sm:row-span-1">{icon}</span>
        <span className="col-start-2 row-start-1 flex items-center gap-2 font-semibold">
          {label}
          {badge}
        </span>
        <span
          id={descriptionId}
          className="col-start-2 row-start-2 min-w-0 text-sm font-normal leading-relaxed text-muted-foreground max-sm:col-span-3 max-sm:col-start-1"
        >
          {description}
        </span>
        <span className="relative col-start-3 row-span-2 row-start-1 size-4 max-sm:row-span-1">
          <input
            type="radio"
            name={name}
            value={value}
            checked={checked}
            disabled={disabled}
            onChange={onSelect}
            aria-label={accessibleLabel ?? label}
            aria-describedby={descriptionId}
            className="m-0 block size-4 cursor-pointer appearance-none rounded-full border border-border-strong bg-background checked:border-transparent checked:bg-brand checked:bg-origin-border checked:[background-image:var(--gradient-brand)] focus-visible:outline-none disabled:cursor-not-allowed forced-colors:appearance-auto forced-colors:focus-visible:outline-auto"
          />
          {checked && (
            <span
              aria-hidden="true"
              className="pointer-events-none absolute left-1/2 top-1/2 size-1.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-brand-foreground forced-colors:hidden"
            />
          )}
        </span>
      </label>
      {footer}
    </div>
  )
}
