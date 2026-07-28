/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Animated voice waveform (THU-689) — a full-width equalizer that makes it
 * obvious you're in voice mode. Bars stretch edge-to-edge and behave per session
 * state. While listening it reacts to your real mic level, and while speaking to
 * the assistant's actual TTS output level; idle/thinking play a canned animation
 * (a traveling "thinking" shimmer, a calm idle line). Bar shapes are derived
 * deterministically from the index (no per-render randomness) so the animation is
 * stable across re-renders.
 */
import type { SessionState } from '@/voice/session'
import { m } from 'framer-motion'
import { type CSSProperties, useEffect, useRef } from 'react'

const barCount = 40
const minHeight = 12 // % of track — the resting line

/** Per-state peak amplitude (fraction of track added on top of minHeight). */
const amplitude: Record<SessionState, number> = { idle: 0, listening: 0.45, thinking: 0, speaking: 0.85 }
const durations: Record<SessionState, number> = { idle: 1.2, listening: 1.0, thinking: 1.1, speaking: 0.42 }

/** Deterministic 0..1 shape for bar `i`: a center hump plus fine wiggle. */
const barPeak = (i: number): number => {
  const hump = Math.sin(((i + 0.5) / barCount) * Math.PI) // taller toward the middle
  const wiggle = 0.5 + 0.5 * Math.sin(i * 1.7) // stable per-bar detail
  return 0.4 * hump + 0.6 * wiggle
}

type LevelRef = { readonly current: number }

type VoiceWaveformProps = {
  state: SessionState
  levelRef?: LevelRef
  outputLevelRef?: LevelRef
  className?: string
}

export const VoiceWaveform = ({ state, levelRef, outputLevelRef, className = '' }: VoiceWaveformProps) => {
  if (state === 'listening' && levelRef) {
    return <ReactiveBars levelRef={levelRef} className={className} />
  }
  if (state === 'speaking' && outputLevelRef) {
    return <ReactiveBars levelRef={outputLevelRef} className={className} />
  }
  return <CannedBars state={state} className={className} />
}

/**
 * Mic-reactive bars. A single rAF loop smooths the level and writes ONE CSS
 * variable (`--level`) on the container; every bar's `scaleY` reads it via
 * `calc()`, so all 40 update without any React re-render or per-bar JS.
 */
const ReactiveBars = ({ levelRef, className }: { levelRef: LevelRef; className: string }) => {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    let raf = 0
    let smoothed = 0
    const tick = () => {
      // sqrt curve lifts quiet speech into visible range; then ease toward it.
      const target = Math.min(1, Math.sqrt(Math.max(0, levelRef.current) * 6))
      smoothed += (target - smoothed) * 0.35
      ref.current?.style.setProperty('--level', smoothed.toFixed(3))
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [levelRef])
  return (
    <div ref={ref} className={`flex h-full w-full items-center justify-between ${className}`} aria-hidden>
      {Array.from({ length: barCount }, (_, i) => (
        <span
          key={i}
          className="h-full w-[3px] shrink-0 origin-center rounded-full bg-primary"
          style={
            {
              '--peak': barPeak(i).toFixed(3),
              transform: 'scaleY(clamp(0.1, calc(var(--level, 0) * var(--peak) * 0.95 + 0.08), 1))',
            } as CSSProperties
          }
        />
      ))}
    </div>
  )
}

const CannedBars = ({ state, className }: { state: SessionState; className: string }) => {
  const isFlat = state === 'idle' || state === 'thinking'
  return (
    <div className={`flex h-full w-full items-center justify-between ${className}`} aria-hidden>
      {Array.from({ length: barCount }, (_, i) => {
        const high = Math.round(minHeight + amplitude[state] * barPeak(i) * (100 - minHeight))
        return (
          <m.span
            key={i}
            className="w-[3px] shrink-0 rounded-full bg-primary"
            animate={
              isFlat
                ? { height: `${minHeight}%`, opacity: state === 'thinking' ? [0.3, 1, 0.3] : 0.5 }
                : { height: [`${minHeight}%`, `${high}%`, `${Math.round(high * 0.55)}%`] }
            }
            transition={{
              duration: durations[state],
              repeat: Number.POSITIVE_INFINITY,
              repeatType: 'mirror',
              ease: 'easeInOut',
              delay: (i % 12) * (state === 'thinking' ? 0.06 : 0.035),
            }}
          />
        )
      })}
    </div>
  )
}
