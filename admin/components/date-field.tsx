/* UNLICENSED — license TBD. This file is not licensed under MPL-2.0.
 * All rights reserved. See admin/LICENSE.
 * Enterprise support and licensing: contact info@thunderbolt.io. */

import { Trans } from '@lingui/react/macro'
import { CalendarDays } from 'lucide-react'
import { useState, type ReactNode } from 'react'
import { Button } from '@/components/ui/button'
import { Calendar } from '@/components/ui/calendar'
import { inputVariants } from '@/components/ui/input'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { toDate } from '@/i18n/format'
import { useFormatters } from '@/i18n/use-formatters'
import { cn } from '@/lib/utils'

/** A date as the local `YYYY-MM-DD` day a `DateField` holds. */
export const toLocalDay = (date: Date): string => {
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

type DateFieldProps = {
  id: string
  /** A local `YYYY-MM-DD` day, or '' for none. */
  value: string
  onChange: (value: string) => void
  placeholder: ReactNode
  /** The earliest day that can be picked, as `YYYY-MM-DD`. */
  min?: string
  'aria-describedby'?: string
}

/** A date input: a field-shaped button that opens a calendar, with a way back to no date. */
export const DateField = ({ id, value, onChange, placeholder, min, ...aria }: DateFieldProps) => {
  const formatters = useFormatters()
  const [open, setOpen] = useState(false)
  const selected = value ? toDate(value) : undefined

  const pick = (day: string) => {
    onChange(day)
    setOpen(false)
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          id={id}
          type="button"
          className={cn(inputVariants(), 'items-center justify-between gap-2 text-left')}
          {...aria}
        >
          <span className={cn('truncate', !selected && 'text-muted-foreground')}>
            {selected ? formatters.date(selected) : placeholder}
          </span>
          <CalendarDays className="size-[var(--icon-size-sm)] shrink-0 text-muted-foreground" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-auto p-2">
        <Calendar
          mode="single"
          selected={selected}
          defaultMonth={selected}
          disabled={min ? { before: toDate(min) } : undefined}
          onSelect={(date) => date && pick(toLocalDay(date))}
        />
        {value && (
          <div className="flex justify-end border-t pt-2">
            <Button type="button" variant="ghost" size="sm" onClick={() => pick('')}>
              <Trans>Clear date</Trans>
            </Button>
          </div>
        )}
      </PopoverContent>
    </Popover>
  )
}
