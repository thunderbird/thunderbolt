/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Quote, X } from 'lucide-react'

type QuoteChipProps = {
  /** The quoted passage. */
  text: string
  /** When set, shows a remove affordance (pending composer quote). */
  onRemove?: () => void
}

/**
 * A first-class quote-reply chip for the composer: a compact blockquote-styled
 * pill showing the passage the user pulled in from a response (see the "Reply"
 * button on assistant messages). The preview clamps to two lines; clicking it
 * opens a scrollable popover with the full passage.
 */
export const QuoteChip = ({ text, onRemove }: QuoteChipProps) => (
  <div className="group relative flex max-w-full items-start rounded-md border border-l-2 border-l-primary/60 bg-muted/50">
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          title="View quote"
          className="flex min-w-0 flex-1 cursor-pointer items-start gap-2 rounded-md py-1.5 pl-2.5 pr-7 text-left hover:bg-muted"
        >
          <Quote className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
          <span className="line-clamp-2 min-w-0 whitespace-pre-wrap text-[length:var(--font-size-xs)] text-muted-foreground">
            {text}
          </span>
        </button>
      </PopoverTrigger>
      <PopoverContent side="top" align="start" className="max-h-64 w-80 max-w-[90vw] overflow-y-auto p-3">
        <blockquote className="whitespace-pre-wrap border-l-2 border-l-primary/60 pl-3 text-[length:var(--font-size-sm)] text-foreground">
          {text}
        </blockquote>
      </PopoverContent>
    </Popover>
    {onRemove && (
      <button
        type="button"
        onClick={onRemove}
        aria-label="Remove quote"
        className="absolute right-1 top-1 cursor-pointer rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
      >
        <X className="size-3.5" />
      </button>
    )}
  </div>
)
