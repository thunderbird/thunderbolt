/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Emoji chooser for a project's icon.
 *
 * A curated grid rather than a full emoji-picker dependency: a project icon only
 * needs to be recognisable at 16px in the sidebar, and much of the full set
 * (skin-tone variants, ZWJ sequences, detailed flags) is an indistinct smudge at
 * that size. Forty glyphs in four labelled groups fit on one screen.
 *
 * Deliberately no search box. Searching needs per-emoji keywords, and the only
 * correct source for those is Unicode CLDR annotations (what `emojibase-data`
 * and `emoji-mart` package) — hand-writing them means inventing a vocabulary
 * that is English-only and wrong as often as it is right. At this set size the
 * whole grid is visible at a glance, so scanning beats searching anyway. If the
 * set ever grows past one screen, add CLDR data rather than prose keywords.
 */

import { Smile, X } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { cn } from '@/lib/utils'

/** Grouped so the grid reads as categories rather than noise. */
const emojiGroups: readonly { label: string; emoji: readonly string[] }[] = [
  { label: 'Work', emoji: ['📁', '📊', '📈', '📝', '📌', '🗂️', '📅', '💼', '🧾', '🗒️'] },
  { label: 'Craft', emoji: ['🛠️', '⚙️', '🧩', '🔧', '🧪', '🔬', '🧠', '💡', '🎯', '🚀'] },
  { label: 'Topic', emoji: ['🌍', '🏛️', '⚖️', '🏥', '🎓', '🔐', '💰', '📡', '🌱', '⚡'] },
  { label: 'Play', emoji: ['🎨', '🎬', '🎵', '📷', '🕹️', '☕', '🏔️', '🐝', '🌤️', '✨'] },
]

type EmojiPickerProps = {
  /** Current emoji, or null for the default folder glyph. */
  value: string | null
  onChange: (emoji: string | null) => void
  /** Accessible name for the trigger (the project's name). */
  label: string
}

export const EmojiPicker = ({ value, onChange, label }: EmojiPickerProps) => (
  <Popover>
    <PopoverTrigger asChild>
      <Button
        variant="outline"
        // Square so the glyph is optically centred; emoji have no consistent
        // baseline, so the fixed box beats padding around variable-width text.
        // `bg-card` to match the adjacent field: an `outline` button is
        // transparent by default and would read as a hole next to a white input.
        className="size-10 shrink-0 cursor-pointer bg-card p-0 text-[1.25rem] leading-none dark:bg-input"
        aria-label={`Choose an icon for ${label}`}
      >
        {value ?? <Smile className="size-[var(--icon-size-default)] text-muted-foreground" aria-hidden="true" />}
      </Button>
    </PopoverTrigger>
    <PopoverContent className="w-auto max-w-[19rem] p-3" align="start">
      <div className="flex flex-col gap-3">
        {emojiGroups.map((group) => (
          <div key={group.label} className="flex flex-col gap-1.5">
            <span className="text-[length:var(--font-size-xs)] font-medium uppercase tracking-wide text-muted-foreground">
              {group.label}
            </span>
            <div className="grid grid-cols-10 gap-1">
              {group.emoji.map((emoji) => (
                <button
                  key={emoji}
                  type="button"
                  onClick={() => onChange(emoji)}
                  aria-label={emoji}
                  aria-pressed={value === emoji}
                  className={cn(
                    'flex size-7 cursor-pointer items-center justify-center rounded-md text-[1.05rem] leading-none transition-colors hover:bg-accent',
                    value === emoji && 'bg-accent ring-1 ring-ring',
                  )}
                >
                  {emoji}
                </button>
              ))}
            </div>
          </div>
        ))}
        {value && (
          <Button variant="ghost" size="sm" className="cursor-pointer self-start" onClick={() => onChange(null)}>
            <X className="size-[var(--icon-size-sm)]" aria-hidden="true" />
            Remove icon
          </Button>
        )}
      </div>
    </PopoverContent>
  </Popover>
)
