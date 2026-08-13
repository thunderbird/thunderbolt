/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Emoji chooser for a project's icon: the full Unicode set with keyword search.
 *
 * Two things keep it cheap. The catalogue is **dynamically imported** on first
 * open (see `emoji-catalog.ts`), so its ~79 KB gzipped stays out of the entry
 * chunk. And the grid is **virtualized** with `virtua` — 1,870 emoji is far too
 * many DOM nodes to mount at once, and without windowing the popover stutters on
 * open and on every keystroke.
 *
 * Responsive shell, one body: a popover on desktop, a bottom sheet on touch —
 * mirroring `ResponsiveActionMenu`. A 19rem popover anchored to a button is
 * cramped on a phone, and 28px cells are well under the 44px touch guideline, so
 * mobile gets a wider grid with larger targets.
 *
 * We do NOT try to summon the OS emoji keyboard. There is no way to request
 * emoji-only input from a webview (`inputmode` has no such value); the keyboard's
 * emoji mode is the user's own switch. Getting a genuinely emoji-restricted
 * keyboard would need a native input accessory per platform.
 */

import { Search, Smile, X } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { Virtualizer } from 'virtua'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { MobileActionSheet } from '@/components/ui/mobile-action-sheet'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { useIsMobile } from '@/hooks/use-mobile'
import { cn } from '@/lib/utils'
import {
  filterCatalog,
  loadEmojiCatalog,
  suggestedEmoji,
  toRows,
  type EmojiCategory,
  type EmojiEntry,
} from './emoji-catalog'

/** Emoji per row. Desktop fits 9 in a 19rem popover; the sheet is full-width. */
const desktopPerRow = 9
const mobilePerRow = 8

type EmojiPickerProps = {
  /** Current emoji, or null for the default folder glyph. */
  value: string | null
  onChange: (emoji: string | null) => void
  /** Accessible name for the trigger (the project's name). */
  label: string
}

const EmojiButton = ({
  native,
  name,
  isSelected,
  isMobile,
  onSelect,
}: {
  native: string
  name: string
  isSelected: boolean
  isMobile: boolean
  onSelect: () => void
}) => (
  <button
    type="button"
    onClick={onSelect}
    aria-label={name}
    title={name}
    aria-pressed={isSelected}
    className={cn(
      'flex cursor-pointer items-center justify-center rounded-md leading-none transition-colors hover:bg-accent',
      // Touch targets: 40px on mobile vs 28px on desktop, where a cursor is precise.
      isMobile ? 'size-10 text-[1.5rem]' : 'size-7 text-[1.05rem]',
      isSelected && 'bg-accent ring-1 ring-ring',
    )}
  >
    {native}
  </button>
)

/** A flat row in the virtualized list: either a category heading or a row of emoji. */
type GridRow = { kind: 'heading'; label: string } | { kind: 'emoji'; entries: EmojiEntry[] }

/** Flatten categories into the heading/emoji row sequence the virtualizer renders. */
const toGridRows = (categories: readonly EmojiCategory[], perRow: number): GridRow[] =>
  categories.flatMap((category) => [
    { kind: 'heading' as const, label: category.label },
    ...toRows(category.emoji, perRow).map((entries) => ({ kind: 'emoji' as const, entries })),
  ])

/**
 * Search field + suggested row + virtualized full set. Shared by both shells so
 * the two presentations can't drift in behaviour.
 */
const EmojiPickerBody = ({
  value,
  onChange,
  isMobile,
}: Pick<EmojiPickerProps, 'value' | 'onChange'> & { isMobile: boolean }) => {
  const [search, setSearch] = useState('')
  // `'failed'` rather than a third `useState`: the load has three outcomes, and one
  // slot keeps them mutually exclusive.
  const [catalog, setCatalog] = useState<EmojiCategory[] | 'failed' | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const perRow = isMobile ? mobilePerRow : desktopPerRow

  // Legitimate effect: fetching from an external module on mount. The catalogue
  // module memoizes a *successful* load, so reopening never re-imports — and it
  // does not cache a failure, so reopening after one really does retry.
  useEffect(() => {
    let cancelled = false
    const load = async () => {
      try {
        const loaded = await loadEmojiCatalog()
        if (!cancelled) {
          setCatalog(loaded)
        }
      } catch (error) {
        // A rejected dynamic import (offline, or a chunk 404 after a redeploy)
        // would otherwise leave the body on "Loading emoji…" forever.
        console.warn('Failed to load the emoji catalogue', error)
        if (!cancelled) {
          setCatalog('failed')
        }
      }
    }
    load()
    return () => {
      cancelled = true
    }
  }, [])

  const rows = useMemo(
    () => (catalog && catalog !== 'failed' ? toGridRows(filterCatalog(catalog, search), perRow) : []),
    [catalog, search, perRow],
  )
  const showSuggested = search.trim().length === 0
  const gridClass = isMobile ? 'grid grid-cols-8 gap-1' : 'grid grid-cols-9 gap-1'

  return (
    <div className={cn('flex flex-col gap-3', !isMobile && 'w-[19rem]')}>
      <div className="relative">
        <Search
          className="pointer-events-none absolute top-1/2 left-2 size-[var(--icon-size-sm)] -translate-y-1/2 text-muted-foreground"
          aria-hidden="true"
        />
        <Input
          // No autofocus on mobile: it would raise the software keyboard over the
          // grid the user came here to look at.
          autoFocus={!isMobile}
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder="Search emoji"
          aria-label="Search emoji"
          className="h-[var(--touch-height-sm)] bg-card pl-7 dark:bg-input"
        />
      </div>

      {showSuggested && (
        <div className="flex flex-col gap-1.5">
          <span className="text-[length:var(--font-size-xs)] font-medium tracking-wide text-muted-foreground uppercase">
            Suggested
          </span>
          <div className={gridClass}>
            {suggestedEmoji.slice(0, perRow * 4).map((emoji) => (
              <EmojiButton
                key={emoji}
                native={emoji}
                name={emoji}
                isMobile={isMobile}
                isSelected={value === emoji}
                onSelect={() => onChange(emoji)}
              />
            ))}
          </div>
        </div>
      )}

      {catalog === 'failed' ? (
        <p role="alert" className="py-6 text-center text-[length:var(--font-size-sm)] text-muted-foreground">
          Couldn’t load the emoji list. Close and reopen this picker to try again.
        </p>
      ) : catalog === null ? (
        <p className="py-6 text-center text-[length:var(--font-size-sm)] text-muted-foreground">Loading emoji…</p>
      ) : rows.length === 0 ? (
        <p className="py-6 text-center text-[length:var(--font-size-sm)] text-muted-foreground">No matches</p>
      ) : (
        <div ref={scrollRef} className={cn('overflow-y-auto', isMobile ? 'h-[45vh]' : 'h-56')}>
          <Virtualizer scrollRef={scrollRef}>
            {rows.map((row, index) =>
              row.kind === 'heading' ? (
                <div
                  key={`h-${row.label}-${index}`}
                  className="pt-2 pb-1.5 text-[length:var(--font-size-xs)] font-medium tracking-wide text-muted-foreground uppercase"
                >
                  {row.label}
                </div>
              ) : (
                <div key={`r-${index}`} className={gridClass}>
                  {row.entries.map((entry) => (
                    <EmojiButton
                      key={entry.native}
                      native={entry.native}
                      name={entry.name}
                      isMobile={isMobile}
                      isSelected={value === entry.native}
                      onSelect={() => onChange(entry.native)}
                    />
                  ))}
                </div>
              ),
            )}
          </Virtualizer>
        </div>
      )}

      {value && (
        <Button variant="ghost" size="sm" className="cursor-pointer self-start" onClick={() => onChange(null)}>
          <X className="size-[var(--icon-size-sm)]" aria-hidden="true" />
          Remove icon
        </Button>
      )}
    </div>
  )
}

export const EmojiPicker = ({ value, onChange, label }: EmojiPickerProps) => {
  const { isMobile } = useIsMobile()
  const [open, setOpen] = useState(false)

  // Choosing an icon closes the picker: it's a single-value control, so staying
  // open just hides the result the user came to see.
  const handleChange = (emoji: string | null) => {
    onChange(emoji)
    setOpen(false)
  }

  const trigger = (
    <Button
      variant="outline"
      // Square so the glyph is optically centred; emoji have no consistent
      // baseline, so the fixed box beats padding around variable-width text.
      // `bg-card` to match the adjacent field: an `outline` button is
      // transparent by default and would read as a hole next to a white input.
      className="size-10 shrink-0 cursor-pointer bg-card p-0 text-[1.25rem] leading-none dark:bg-input"
      aria-label={`Choose an icon for ${label}`}
      onClick={isMobile ? () => setOpen(true) : undefined}
    >
      {value ?? <Smile className="size-[var(--icon-size-default)] text-muted-foreground" aria-hidden="true" />}
    </Button>
  )

  if (isMobile) {
    return (
      <>
        {trigger}
        <MobileActionSheet open={open} onOpenChange={setOpen} title="Choose an icon">
          {/* Keyed so the body remounts per opening — search resets, and the
              memoized catalogue makes the remount free. */}
          {open && <EmojiPickerBody key="sheet" value={value} onChange={handleChange} isMobile />}
        </MobileActionSheet>
      </>
    )
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>{trigger}</PopoverTrigger>
      <PopoverContent className="w-auto p-3" align="start">
        {open && <EmojiPickerBody key="popover" value={value} onChange={handleChange} isMobile={false} />}
      </PopoverContent>
    </Popover>
  )
}
