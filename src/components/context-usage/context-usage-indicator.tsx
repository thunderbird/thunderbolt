/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Trans, useLingui } from '@lingui/react/macro'
import { Loader2 } from 'lucide-react'
import { useFormatters } from '@/i18n/use-formatters'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useContextUsageState } from './use-context-usage-state'

type ContextUsageIndicatorProps = {
  usedTokens: number
  maxTokens: number
  className?: string
  onCompact?: (instructions?: string) => Promise<void>
  busy?: boolean
  compacting?: boolean
  hasHistory?: boolean
  onViewSummary?: () => void
}

/**
 * Context usage indicator component showing token usage as a progress ring
 */
export const ContextUsageIndicator = ({
  usedTokens = 0,
  maxTokens,
  className,
  onCompact,
  busy,
  compacting,
  hasHistory = true,
  onViewSummary,
}: ContextUsageIndicatorProps) => {
  const { t } = useLingui()
  const state = useContextUsageState(onCompact)
  const pending = compacting || state.pending
  const formatters = useFormatters()
  const percentage = maxTokens > 0 ? Math.max(0, Math.min((usedTokens / maxTokens) * 100, 100)) : 0
  const roundedPercentage = Math.round(percentage)
  const usedTokensLabel = formatters.compactNumber(usedTokens)
  const maxTokensLabel = formatters.compactNumber(maxTokens)

  const strokeColor = 'rgb(107 114 128)' // gray-500 - consistent darker gray

  // SVG circle parameters
  const size = 24
  const strokeWidth = 3
  const radius = (size - strokeWidth) / 2
  const circumference = 2 * Math.PI * radius
  const strokeDasharray = circumference
  const strokeDashoffset = circumference - (percentage / 100) * circumference

  const percentageText = formatters.percent(roundedPercentage / 100)

  return (
    <div className={cn('flex items-center gap-2', className)}>
      <Popover open={state.open} onOpenChange={state.setOpen}>
        <Tooltip>
          <TooltipTrigger asChild>
            <PopoverTrigger asChild>
              <button
                type="button"
                aria-label={t`Context usage`}
                aria-busy={pending}
                className="flex h-[var(--touch-height-control)] shrink-0 cursor-pointer items-center justify-center gap-1.5 rounded-[var(--radius-control)] px-2 text-muted-foreground transition-colors hover:bg-accent/50 hover:text-foreground aria-expanded:bg-accent aria-expanded:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
              >
                {pending ? (
                  <Loader2 className="size-[var(--icon-size-default)] animate-spin" aria-hidden="true" />
                ) : (
                  <svg
                    viewBox={`0 0 ${size} ${size}`}
                    className="size-[var(--icon-size-default)] -rotate-90"
                    aria-hidden="true"
                  >
                    {/* Background circle */}
                    <circle
                      cx={size / 2}
                      cy={size / 2}
                      r={radius}
                      fill="none"
                      stroke="rgb(229 231 235)"
                      strokeWidth={strokeWidth}
                    />
                    {/* Progress circle */}
                    <circle
                      cx={size / 2}
                      cy={size / 2}
                      r={radius}
                      fill="none"
                      stroke={strokeColor}
                      strokeWidth={strokeWidth}
                      strokeDasharray={strokeDasharray}
                      strokeDashoffset={strokeDashoffset}
                      strokeLinecap="round"
                      className="transition-all duration-300 ease-in-out"
                    />
                  </svg>
                )}
                <span className="text-xs text-muted-foreground whitespace-nowrap">{percentageText}</span>
              </button>
            </PopoverTrigger>
          </TooltipTrigger>
          {!state.open && (
            <TooltipContent>
              <Trans>
                {usedTokensLabel} of {maxTokensLabel} Context Window
              </Trans>
            </TooltipContent>
          )}
        </Tooltip>
        <PopoverContent align="start" className="flex w-64 max-w-[calc(100vw-2rem)] flex-col gap-0.5 p-1">
          {onCompact ? (
            <>
              <div className="px-1 py-1.5">
                <Textarea
                  aria-label={t`Compaction instructions (optional)`}
                  value={state.instructions}
                  onChange={(event) => state.setInstructions(event.target.value)}
                  placeholder={t`Add summary instructions (optional)`}
                  disabled={pending}
                  rows={3}
                  className="rounded-md px-2 py-1.5 text-[length:var(--font-size-sm)]"
                />
              </div>
              {state.failed && (
                <p role="alert" className="px-2 py-1.5 text-[length:var(--font-size-sm)] text-destructive">
                  <Trans>Could not compact context. Your chat history is safe. Please try again.</Trans>
                </p>
              )}
            </>
          ) : (
            <p className="px-2 py-1.5 text-[length:var(--font-size-sm)] text-muted-foreground">
              <Trans>Context compaction is available with supported built-in models.</Trans>
            </p>
          )}
          <div
            className={cn('gap-2 px-1 pb-1.5', onCompact && onViewSummary ? 'grid grid-cols-2' : 'flex justify-end')}
          >
            {onViewSummary && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-auto min-w-0 rounded-md px-2 py-1.5 text-[length:var(--font-size-sm)] whitespace-normal font-normal"
                onClick={() => {
                  state.setOpen(false)
                  onViewSummary()
                }}
              >
                <Trans>View summary</Trans>
              </Button>
            )}
            {onCompact && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <span
                    tabIndex={(busy || !hasHistory) && !pending ? 0 : undefined}
                    className="inline-flex min-w-0 rounded-md focus-visible:outline-2 focus-visible:outline-ring"
                  >
                    <Button
                      type="button"
                      variant="default"
                      size="sm"
                      disabled={busy || pending || !hasHistory}
                      onClick={state.compact}
                      className="h-auto w-full min-w-0 rounded-md px-2 py-1.5 text-[length:var(--font-size-sm)] whitespace-normal font-normal"
                    >
                      {pending ? <Trans>Compacting context…</Trans> : <Trans>Compact now</Trans>}
                    </Button>
                  </span>
                </TooltipTrigger>
                {(busy || !hasHistory) && !pending && (
                  <TooltipContent className="max-w-56 text-wrap">
                    {busy ? (
                      <Trans>Wait for the current response to finish before compacting.</Trans>
                    ) : (
                      <Trans>Nothing to compact yet.</Trans>
                    )}
                  </TooltipContent>
                )}
              </Tooltip>
            )}
          </div>
        </PopoverContent>
      </Popover>
    </div>
  )
}
