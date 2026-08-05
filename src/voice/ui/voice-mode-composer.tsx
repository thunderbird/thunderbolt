/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Voice-mode composer overlay (THU-689). Voice replaces typing, so the composer
 * *becomes* the voice surface: this covers the prompt box in-place (matching its
 * rounded box + background) with the waveform, current state, and an exit — no
 * detached floating widget. The conversation still streams into normal chat
 * bubbles above, Claude-Desktop style.
 */
import type { SessionState } from '@/voice/session'
import { VoiceWaveform } from '@/voice/ui/voice-waveform'
import { m } from 'framer-motion'
import { MicOff, X } from 'lucide-react'

const statusLabel: Record<SessionState, string> = {
  idle: 'Starting…',
  listening: 'Listening',
  thinking: 'Thinking',
  speaking: 'Speaking',
}

type VoiceModeComposerProps = {
  state: SessionState
  error?: string | null
  levelRef?: { readonly current: number }
  outputLevelRef?: { readonly current: number }
  onClose: () => void
}

export const VoiceModeComposer = ({ state, error, levelRef, outputLevelRef, onClose }: VoiceModeComposerProps) => (
  <m.div
    initial={{ opacity: 0 }}
    animate={{ opacity: 1 }}
    exit={{ opacity: 0 }}
    transition={{ duration: 0.18, ease: 'easeOut' }}
    // Mirror the PromptInput box (rounded-3xl border bg-sidebar) so it reads as the
    // same composer, just in voice mode — same radius/fill means no corners peek
    // out underneath. z-20 sits above the PromptInput (z-10).
    className="absolute inset-0 z-20 flex items-center gap-3 rounded-3xl border bg-sidebar py-2 pl-4 pr-2 dark:border-input"
    role="status"
    aria-label={`Voice mode: ${statusLabel[state]}`}
  >
    {error ? (
      <div className="flex min-w-0 flex-1 items-center gap-2 text-destructive">
        <MicOff className="size-[var(--icon-size-sm)] shrink-0" />
        <span className="line-clamp-2 min-w-0 select-text text-[length:var(--font-size-sm)] font-medium" title={error}>
          {error}
        </span>
      </div>
    ) : (
      <>
        <VoiceWaveform state={state} levelRef={levelRef} outputLevelRef={outputLevelRef} className="min-w-0 flex-1" />
        <span className="shrink-0 text-[length:var(--font-size-xs)] font-medium text-muted-foreground">
          {statusLabel[state]}
        </span>
      </>
    )}
    <button
      type="button"
      onClick={onClose}
      aria-label="Exit voice mode"
      title="Exit voice mode"
      className="flex size-[var(--touch-height-sm)] shrink-0 items-center justify-center rounded-full bg-foreground text-background transition-transform hover:scale-105"
    >
      <X className="size-[var(--icon-size-sm)]" />
    </button>
  </m.div>
)
