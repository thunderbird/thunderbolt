/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useState, type CSSProperties, type ReactNode } from 'react'
import { ChevronDown, RotateCcw } from 'lucide-react'
import { useLingui } from '@lingui/react/macro'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { useCurrentChatSession } from '@/chats/chat-store'
import { useEffortSelectorState } from './use-effort-selector-state'
import { GradientLock } from '@/components/ui/gradient-lock'
import './effort-selector.css'

export const EffortSelector = ({ modelPicker }: { modelPicker?: ReactNode }) => {
  const { t } = useLingui()
  const { selectedModel, selectedAgent } = useCurrentChatSession()
  const { error, choices, value, busy, choose } = useEffortSelectorState()
  const [preview, setPreview] = useState<number | null>(null)
  if (!choices.length) {
    return modelPicker ?? null
  }
  const current = Math.max(
    0,
    choices.findIndex((choice) => choice.value === value),
  )
  const index = preview ?? current
  const selected = choices[index] ?? choices[current]!
  const progress = choices.length > 1 ? (index / (choices.length - 1)) * 100 : 0
  const commit = () => {
    if (preview !== null) {
      choose(selected.value)
      setPreview(null)
    }
  }
  const reset = choices.find((choice) => choice.value === 'default')
  return (
    <Popover onOpenChange={() => setPreview(null)}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={modelPicker ? t`Model and reasoning effort` : t`Reasoning effort`}
          title={t`Higher effort can improve difficult answers but takes more time and tokens.`}
          className="flex shrink-0 cursor-pointer items-center gap-1.5 px-2 h-[var(--touch-height-control)] rounded-[var(--radius-control)] text-[length:var(--font-size-sm)] font-medium text-muted-foreground transition-colors hover:bg-accent/50 data-[state=open]:bg-accent focus-visible:outline-2 focus-visible:outline-ring disabled:cursor-default disabled:opacity-50"
        >
          {modelPicker && selectedModel.isConfidential === 1 && <GradientLock className="size-3.5 shrink-0" />}
          {modelPicker && <span className="max-w-40 truncate">{selectedModel.name}</span>}
          {modelPicker && <span aria-hidden="true" className="size-0.5 rounded-full bg-muted-foreground/60" />}
          <span>{choices[current]?.name}</span>
          <ChevronDown aria-hidden="true" className="size-3.5 shrink-0" />
        </button>
      </PopoverTrigger>
      <PopoverContent side="top" align="end" sideOffset={8} className="w-72 p-4">
        <div className="relative mb-4 text-center">
          <div className="px-7 text-lg font-medium text-brand" aria-live="polite">
            {selected.name}
          </div>
          <div className="flex min-w-0 justify-center text-[length:var(--font-size-sm)] text-muted-foreground">
            {modelPicker ?? selectedAgent.name}
          </div>
          {reset && (
            <button
              type="button"
              aria-label={t`Reset reasoning effort`}
              title={t`Reset reasoning effort`}
              disabled={busy || value === reset.value}
              onClick={() => {
                setPreview(null)
                choose(reset.value)
              }}
              className="absolute right-0 top-0 flex size-7 cursor-pointer items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:cursor-default disabled:opacity-30"
            >
              <RotateCcw aria-hidden="true" className="size-4" />
            </button>
          )}
        </div>
        <div
          className="relative flex h-9 items-center"
          style={{ '--effort-progress': `${progress}%` } as CSSProperties}
        >
          <div aria-hidden="true" className="effort-track pointer-events-none absolute inset-x-0 h-6 rounded-full">
            <div className="absolute inset-x-3 inset-y-0 flex items-center justify-between">
              {choices.map((choice) => (
                <span key={choice.value} className="size-1 rounded-full bg-muted-foreground/60" />
              ))}
            </div>
          </div>
          <input
            type="range"
            min={0}
            max={choices.length - 1}
            step={1}
            value={index}
            disabled={choices.length < 2}
            aria-disabled={busy}
            aria-label={t`Reasoning effort`}
            aria-valuetext={selected.name}
            onChange={(event) => {
              if (!busy) {
                setPreview(Number(event.target.value))
              }
            }}
            onPointerUp={commit}
            onKeyUp={commit}
            onBlur={commit}
            className="effort-slider relative w-full cursor-pointer disabled:cursor-default"
          />
        </div>
        {error && (
          <p role="alert" className="mt-2 text-destructive text-[length:var(--font-size-xs)]">
            {error}
          </p>
        )}
      </PopoverContent>
    </Popover>
  )
}
