/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useLingui } from '@lingui/react/macro'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import { type ComponentProps } from 'react'
import { DayPicker, getDefaultClassNames } from 'react-day-picker'

import { buttonVariants } from '@/components/ui/button'
import { useFormatters } from '@/i18n/use-formatters'
import { useActiveLocale } from '@/i18n/use-active-locale'
import { cn } from '@/lib/utils'

type Weekday = 0 | 1 | 2 | 3 | 4 | 5 | 6

type WeekInfoLocale = Intl.Locale & {
  getWeekInfo?: () => { firstDay: number }
  weekInfo?: { firstDay: number }
}

/**
 * The locale's first day of the week as DayPicker counts it (0 = Sunday), from CLDR via `Intl.Locale`.
 * `getWeekInfo()` is the standard accessor; older WebKit only has the `weekInfo` getter.
 */
export const firstDayOfWeek = (locale: string): Weekday => {
  const intlLocale = new Intl.Locale(locale) as WeekInfoLocale
  const firstDay = intlLocale.getWeekInfo?.().firstDay ?? intlLocale.weekInfo?.firstDay ?? 7
  return (firstDay % 7) as Weekday
}

/**
 * A month grid for picking dates. Month and weekday names come from `Intl` through the app's formatters,
 * so no date-fns locale is loaded, and the week starts where the active locale starts it.
 */
const Calendar = ({ className, classNames, showOutsideDays = true, ...props }: ComponentProps<typeof DayPicker>) => {
  const { t } = useLingui()
  const locale = useActiveLocale()
  const formatters = useFormatters()
  const defaults = getDefaultClassNames()

  return (
    <DayPicker
      showOutsideDays={showOutsideDays}
      lang={locale}
      weekStartsOn={firstDayOfWeek(locale)}
      className={cn('p-1', className)}
      formatters={{
        formatCaption: (month) => formatters.monthYear(month),
        formatWeekdayName: (weekday) => formatters.weekday(weekday),
        formatDay: (date) => formatters.number(date.getDate()),
      }}
      labels={{
        labelNav: () => t`Choose a month`,
        labelPrevious: () => t`Previous month`,
        labelNext: () => t`Next month`,
        labelGrid: (month) => formatters.monthYear(month),
        labelDayButton: (date, modifiers) => {
          const day = formatters.date(date)
          if (modifiers.today && modifiers.selected) {
            return t`Today, ${day}, selected`
          }
          if (modifiers.today) {
            return t`Today, ${day}`
          }
          return modifiers.selected ? t`${day}, selected` : day
        },
        labelWeekday: (weekday) => formatters.weekday(weekday),
      }}
      classNames={{
        root: cn('w-fit', defaults.root),
        months: cn('relative flex flex-col gap-4', defaults.months),
        month: cn('flex w-full flex-col gap-2', defaults.month),
        nav: cn('absolute inset-x-0 top-0 flex items-center justify-between', defaults.nav),
        button_previous: cn(buttonVariants({ variant: 'ghost', size: 'icon-sm' }), defaults.button_previous),
        button_next: cn(buttonVariants({ variant: 'ghost', size: 'icon-sm' }), defaults.button_next),
        month_caption: cn('flex h-[var(--touch-height-sm)] items-center justify-center', defaults.month_caption),
        caption_label: cn('text-[length:var(--font-size-body)] font-medium', defaults.caption_label),
        month_grid: cn('w-full border-collapse', defaults.month_grid),
        weekdays: cn('flex', defaults.weekdays),
        weekday: cn(
          'flex-1 select-none text-[length:var(--font-size-xs)] font-normal text-muted-foreground',
          defaults.weekday,
        ),
        week: cn('mt-1 flex w-full', defaults.week),
        day: cn('relative size-[var(--touch-height-sm)] p-0 text-center', defaults.day),
        day_button: cn(
          buttonVariants({ variant: 'ghost', size: 'icon-sm' }),
          'rounded-md font-normal tabular-nums aria-selected:opacity-100',
          defaults.day_button,
        ),
        selected:
          '[&>button]:bg-primary [&>button]:text-primary-foreground [&>button]:hover:bg-primary [&>button]:hover:text-primary-foreground',
        today: '[&>button]:bg-accent [&>button]:text-accent-foreground',
        outside: cn('text-muted-foreground [&>button]:text-muted-foreground', defaults.outside),
        disabled: cn('opacity-50', defaults.disabled),
        hidden: cn('invisible', defaults.hidden),
        ...classNames,
      }}
      components={{
        Chevron: ({ orientation, className: chevronClassName }) =>
          orientation === 'left' ? (
            <ChevronLeft className={cn('size-[var(--icon-size-sm)]', chevronClassName)} />
          ) : (
            <ChevronRight className={cn('size-[var(--icon-size-sm)]', chevronClassName)} />
          ),
      }}
      {...props}
    />
  )
}

export { Calendar }
