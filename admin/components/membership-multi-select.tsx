/* UNLICENSED — license TBD. This file is not licensed under MPL-2.0.
 * All rights reserved. See admin/LICENSE.
 * Enterprise support and licensing: contact info@thunderbolt.io. */

import { Plural } from '@lingui/react/macro'
import { ChevronDown, X } from 'lucide-react'
import { useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { SearchInput } from '@/components/ui/search-input'
import { Label } from '@/components/ui/label'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'

type MembershipItem = { id: string; label: string; description?: string }

type MembershipMultiSelectProps = {
  id: string
  /** The choices. With `onSearch`, the server's results for the current search. */
  items: MembershipItem[]
  selectedIds: string[]
  onChange: (ids: string[]) => void
  placeholder: string
  searchPlaceholder: string
  emptyMessage: string
  removeLabel: (label: string) => string
  /** Search on the server instead of filtering `items` here. Called with each new query. */
  onSearch?: (query: string) => void
}

/**
 * Searchable membership picker with persistent selections and removable chips. A selection stays
 * shown after a search drops it from `items`: the picker remembers every item it has been given.
 */
export const MembershipMultiSelect = ({
  id,
  items,
  selectedIds,
  onChange,
  placeholder,
  searchPlaceholder,
  emptyMessage,
  removeLabel,
  onSearch,
}: MembershipMultiSelectProps) => {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)
  const seenItems = useRef(new Map<string, MembershipItem>())
  for (const item of items) {
    seenItems.current.set(item.id, item)
  }
  const selected = selectedIds.flatMap((itemId) => seenItems.current.get(itemId) ?? [])
  const matches = onSearch
    ? items
    : items.filter((item) =>
        `${item.label} ${item.description ?? ''}`.toLowerCase().includes(query.trim().toLowerCase()),
      )
  const search = (value: string) => {
    setQuery(value)
    onSearch?.(value)
  }
  const toggle = (itemId: string) =>
    onChange(selectedIds.includes(itemId) ? selectedIds.filter((value) => value !== itemId) : [...selectedIds, itemId])

  return (
    <div className="flex flex-col gap-2">
      <Popover
        open={open}
        onOpenChange={(nextOpen) => {
          setOpen(nextOpen)
          if (!nextOpen) {
            search('')
          }
        }}
      >
        <PopoverTrigger asChild>
          <Button id={id} type="button" variant="outline" className="w-full justify-between font-normal">
            <span className={selected.length === 0 ? 'text-muted-foreground' : undefined}>
              {selected.length === 0 ? (
                placeholder
              ) : (
                <Plural value={selected.length} one="# selected" other="# selected" />
              )}
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
            onChange={(event) => search(event.target.value)}
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
                    <span className="block truncate text-[length:var(--font-size-xs)] text-muted-foreground">
                      {item.description}
                    </span>
                  )}
                </span>
              </Label>
            ))}
            {matches.length === 0 && (
              <p className="px-2 py-3 text-[length:var(--font-size-sm)] text-muted-foreground">{emptyMessage}</p>
            )}
          </div>
        </PopoverContent>
      </Popover>
      {selected.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {selected.map((item) => (
            <Button
              key={item.id}
              type="button"
              variant="secondary"
              size="xs"
              aria-label={removeLabel(item.label)}
              onClick={() => toggle(item.id)}
              className="max-w-full"
            >
              <span className="truncate">{item.label}</span>
              <X className="size-3 shrink-0 text-muted-foreground" />
            </Button>
          ))}
        </div>
      )}
    </div>
  )
}
