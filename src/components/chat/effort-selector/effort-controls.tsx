/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useState, type CSSProperties } from 'react'
import { useLingui } from '@lingui/react/macro'
import type { useEffortSelectorState } from './use-effort-selector-state'
import { EffortRing } from './effort-ring'

export const EffortControls = ({ choices, value, busy, choose, error }: ReturnType<typeof useEffortSelectorState>) => {
  const { t } = useLingui()
  const [preview, setPreview] = useState<string | null>(null)
  const current = choices.findIndex((choice) => choice.value === value)
  const previewIndex = choices.findIndex((choice) => choice.value === preview)
  const index = previewIndex >= 0 ? previewIndex : current
  const selected = choices[index]
  const progress = index >= 0 && choices.length > 1 ? (index / (choices.length - 1)) * 100 : 0
  const commit = (inputIndex?: number) => {
    const choice = preview === null ? choices[inputIndex ?? -1] : choices.find((choice) => choice.value === preview)
    if (!busy && choice) {
      choose(choice.value)
    }
    setPreview(null)
  }
  return (
    <div className="shrink-0 border-t bg-gradient-to-br from-brand/5 via-transparent to-primary/5 p-4">
      <div className="mb-3 flex items-center justify-between gap-3">
        <span className="text-[length:var(--font-size-xs)] font-medium text-muted-foreground">{t`Reasoning effort`}</span>
        <div className="flex min-w-0 items-center gap-2 text-brand" aria-live="polite">
          <EffortRing value={selected?.value} values={choices.map((choice) => choice.value)} />
          <span className="min-w-0 text-right text-lg font-medium wrap-break-word">
            {selected?.name ?? t`Choose effort`}
          </span>
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
          disabled={busy || (choices.length < 2 && index >= 0)}
          aria-disabled={busy}
          aria-label={t`Reasoning effort`}
          aria-valuetext={selected?.name ?? t`Choose effort`}
          onChange={(event) => {
            if (!busy) {
              setPreview(choices[Number(event.target.value)].value)
            }
          }}
          onPointerCancel={() => setPreview(null)}
          onPointerUp={(event) => {
            if (event.button === 0) {
              commit(Number(event.currentTarget.value))
            }
          }}
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
    </div>
  )
}
