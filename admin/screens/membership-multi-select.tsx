/* UNLICENSED — license TBD. This file is not licensed under MPL-2.0.
 * All rights reserved. See admin/LICENSE.
 * Enterprise support and licensing: contact info@thunderbolt.io. */

import { useLingui } from '@lingui/react/macro'
import { ChevronDown, X } from 'lucide-react'
import { useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { SearchInput } from '@/components/ui/search-input'
import { Label } from '@/components/ui/label'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { useFormatters } from '@/i18n/use-formatters'

type MembershipMultiSelectProps = {
  id: string
  items: { id: string; label: string; description?: string }[]
  selectedIds: string[]
  onChange: (ids: string[]) => void
  placeholder: string
  searchPlaceholder: string
  emptyMessage: string
  removeLabel: (label: string) => string
}

/** Searchable membership picker with persistent selections and removable chips. */
export const MembershipMultiSelect = ({
  id,
  items,
  selectedIds,
  onChange,
  placeholder,
  searchPlaceholder,
  emptyMessage,
  removeLabel,
}: MembershipMultiSelectProps) => {
  const { t } = useLingui()
  const formatters = useFormatters()
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)
  const selected = items.filter((item) => selectedIds.includes(item.id))
  const count = formatters.number(selected.length)
  const matches = items.filter((item) =>
    `${item.label} ${item.description ?? ''}`.toLowerCase().includes(query.trim().toLowerCase()),
  )
  const toggle = (itemId: string) =>
    onChange(selectedIds.includes(itemId) ? selectedIds.filter((value) => value !== itemId) : [...selectedIds, itemId])

  return (
    <div className="flex flex-col gap-2">
      <Popover
        open={open}
        onOpenChange={(nextOpen) => {
          setOpen(nextOpen)
          if (!nextOpen) {
            setQuery('')
          }
        }}
      >
        <PopoverTrigger asChild>
          <Button id={id} type="button" variant="outline" className="w-full justify-between font-normal">
            <span className={selected.length === 0 ? 'text-muted-foreground' : undefined}>
              {selected.length === 0 ? placeholder : t`${count} selected`}
            </span>
            <ChevronDown className="size-4 shrink-0 text-muted-foreground" />
          </Button>
        </PopoverTrigger>
        <PopoverContent align="start" className="w-(--radix-popover-trigger-width) p-2" aria-label={placeholder}>
          <SearchInput
            ref={inputRef}
            showIcon
            role="searchbox"
            aria-label={searchPlaceholder}
            placeholder={searchPlaceholder}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            className="mb-2"
          />
          <div className="max-h-56 overflow-y-auto">
            {matches.map((item) => (
              <Label
                key={item.id}
                className="flex cursor-pointer items-center gap-3 rounded-md px-2 py-2.5 hover:bg-accent"
              >
                <Checkbox checked={selectedIds.includes(item.id)} onCheckedChange={() => toggle(item.id)} />
                <span className="min-w-0">
                  <span className="block truncate">{item.label}</span>
                  {item.description && (
                    <span className="block truncate text-xs text-muted-foreground">{item.description}</span>
                  )}
                </span>
              </Label>
            ))}
            {matches.length === 0 && <p className="px-2 py-3 text-sm text-muted-foreground">{emptyMessage}</p>}
          </div>
        </PopoverContent>
      </Popover>
      {selected.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {selected.map((item) => (
            <button
              key={item.id}
              type="button"
              aria-label={removeLabel(item.label)}
              onClick={() => toggle(item.id)}
              className="inline-flex max-w-full cursor-pointer items-center gap-1.5 rounded-lg bg-muted px-2 py-1 text-xs text-foreground transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <span className="truncate">{item.label}</span>
              <X className="size-3 shrink-0 text-muted-foreground" />
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
