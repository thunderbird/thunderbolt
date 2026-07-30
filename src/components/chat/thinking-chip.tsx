/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Brain } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'

type ThinkingChipProps = {
  enabled: boolean
  onToggle: () => void
}

/**
 * Composer control for models that advertise thinking / chain-of-thought.
 * Sits beside the model picker; pressed = thinking on for this conversation.
 *
 * Relies on `Tooltip` (which already wraps a provider) — no nested
 * TooltipProvider here.
 */
export const ThinkingChip = ({ enabled, onToggle }: ThinkingChipProps) => (
  <Tooltip>
    <TooltipTrigger asChild>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        aria-pressed={enabled}
        aria-label={enabled ? 'Thinking on' : 'Thinking off'}
        onClick={onToggle}
        className={cn(
          'h-[var(--touch-height-control)] shrink-0 gap-1.5 rounded-[var(--radius-control)] px-2.5',
          'border-none shadow-none hover:bg-accent/50',
          enabled ? 'bg-accent/40 text-foreground' : 'text-muted-foreground',
        )}
      >
        <Brain className="size-[var(--icon-size-default)]" />
        <span className="text-[length:var(--font-size-sm)] font-medium">Thinking</span>
      </Button>
    </TooltipTrigger>
    <TooltipContent side="top">
      {enabled ? 'Thinking enabled for this chat' : 'Thinking disabled for this chat'}
    </TooltipContent>
  </Tooltip>
)
