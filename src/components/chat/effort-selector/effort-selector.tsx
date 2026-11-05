/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useState, type CSSProperties, type ReactNode } from 'react'
import { ChevronDown } from 'lucide-react'
import { useLingui } from '@lingui/react/macro'
import { Drawer, DrawerContent, DrawerHandle, DrawerTitle } from '@/components/ui/drawer'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { useCurrentChatSession } from '@/chats/chat-store'
import { useEffortSelectorState } from './use-effort-selector-state'
import { GradientLock } from '@/components/ui/gradient-lock'
import { useIsMobile } from '@/hooks/use-mobile'
import { EffortRing } from './effort-ring'
import './effort-selector.css'

export const EffortSelector = ({ modelPicker }: { modelPicker?: ReactNode }) => {
  const { t } = useLingui()
  const { selectedModel, selectedAgent, chatThread } = useCurrentChatSession()
  const { isMobile } = useIsMobile()
  const { error, choices, value, busy, choose } = useEffortSelectorState()
  const [open, setOpen] = useState(false)
  const [preview, setPreview] = useState<number | null>(null)
  if (!choices.length) {
    return modelPicker ?? null
  }
  const current = choices.findIndex((choice) => choice.value === value)
  const index = preview ?? current
  const selected = choices[index]
  const progress = index >= 0 && choices.length > 1 ? (index / (choices.length - 1)) * 100 : 0
  const commit = (inputIndex?: number) => {
    const choice = choices[preview ?? inputIndex ?? -1]
    if (!busy && choice) {
      choose(choice.value)
      setPreview(null)
    }
  }
  const effortName = choices[current]?.name ?? t`Choose effort`
  const effortDescription = t`Reasoning effort: ${effortName}`
  const trigger = (
    <button
      type="button"
      onClick={isMobile ? () => setOpen(true) : undefined}
      aria-expanded={isMobile ? open : undefined}
      aria-haspopup="dialog"
      aria-label={modelPicker ? t`Model and reasoning effort` : t`Reasoning effort`}
      title={effortDescription}
      aria-description={effortDescription}
      className="flex shrink-0 cursor-pointer items-center gap-1.5 px-2 h-[var(--touch-height-control)] rounded-[var(--radius-control)] text-[length:var(--font-size-sm)] font-medium text-muted-foreground transition-colors hover:bg-accent/50 data-[state=open]:bg-accent focus-visible:outline-2 focus-visible:outline-ring disabled:cursor-default disabled:opacity-50"
    >
      {modelPicker && selectedModel.isConfidential === 1 && <GradientLock className="size-3.5 shrink-0" />}
      {modelPicker && <span className="max-w-40 truncate">{selectedModel.name}</span>}
      <EffortRing value={value} values={choices.map((choice) => choice.value)} />
      <ChevronDown aria-hidden="true" className="size-3.5 shrink-0" />
    </button>
  )
  const content = (
    <>
      <div className="relative mb-4 text-center">
        <div className="px-7 text-lg font-medium text-brand" aria-live="polite">
          {selected?.name ?? t`Reasoning effort`}
        </div>
        <div className="flex min-w-0 justify-center text-[length:var(--font-size-sm)] text-muted-foreground">
          {modelPicker ?? selectedAgent.name}
        </div>
      </div>
      <div className="relative flex h-9 items-center" style={{ '--effort-progress': `${progress}%` } as CSSProperties}>
        <div aria-hidden="true" className="effort-track pointer-events-none absolute inset-x-0 h-6 rounded-full">
          <div className="absolute inset-x-3 inset-y-0 flex items-center justify-between">
            {choices.map((choice) => (
              <span key={choice.value} className="size-1 rounded-full bg-muted-foreground/60" />
            ))}
          </div>
        </div>
        <input
          type="range"
          onPointerDown={(event) => event.stopPropagation()}
          min={0}
          max={choices.length - 1}
          step={1}
          value={Math.max(0, index)}
          data-selected={index >= 0}
          disabled={choices.length < 2 && index >= 0}
          aria-disabled={busy}
          aria-label={t`Reasoning effort`}
          aria-valuetext={selected?.name ?? t`Reasoning effort`}
          onChange={(event) => {
            if (!busy) {
              setPreview(Number(event.target.value))
            }
          }}
          onPointerUp={(event) => commit(Number(event.currentTarget.value))}
          onKeyUp={(event) => {
            if (
              ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown'].includes(
                event.key,
              )
            ) {
              commit(Number(event.currentTarget.value))
            }
          }}
          onBlur={() => commit()}
          className="effort-slider relative w-full cursor-pointer disabled:cursor-default"
        />
      </div>
      {error && (
        <p role="alert" className="mt-2 text-destructive text-[length:var(--font-size-xs)]">
          {error}
        </p>
      )}
    </>
  )
  const handleOpenChange = (nextOpen: boolean) => {
    setOpen(nextOpen)
    setPreview(null)
  }
  if (isMobile) {
    return (
      <>
        {trigger}
        <Drawer open={open} onOpenChange={handleOpenChange} swipeDirection="down">
          <DrawerContent aria-describedby={undefined}>
            <DrawerHandle className="mt-2 mb-1" />
            <DrawerTitle className="sr-only">{t`Model and reasoning effort`}</DrawerTitle>
            <div className="px-6 pt-4 pb-[max(1.5rem,env(safe-area-inset-bottom))]">{content}</div>
          </DrawerContent>
        </Drawer>
      </>
    )
  }
  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverTrigger asChild>{trigger}</PopoverTrigger>
      <PopoverContent side={!chatThread ? 'bottom' : 'top'} align="end" sideOffset={8} className="w-72 p-4">
        {content}
      </PopoverContent>
    </Popover>
  )
}
