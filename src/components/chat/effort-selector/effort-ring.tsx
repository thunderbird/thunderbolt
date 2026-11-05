/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useId } from 'react'
import { Sparkles } from 'lucide-react'
import { isReasoningEffort, reasoningEfforts, type ReasoningCapabilities } from '@shared/reasoning-effort'

const segmentCount = reasoningEfforts.length - 1

/** Recognize Pi's off alias without assigning native meanings to arbitrary ACP values. */
const nativeEffort = (value: string) => (value === 'off' ? 'none' : value)

/** Native lists use an absolute effort scale; mixed/opaque ACP lists use one ordinal scale. */
const filledSegments = (value: string, values: readonly string[], kind: ReasoningCapabilities['kind']) => {
  const effort = nativeEffort(value)
  if (kind === 'toggle') {
    return effort === 'none' ? 0 : segmentCount
  }
  if (values.every((option) => isReasoningEffort(nativeEffort(option))) && isReasoningEffort(effort)) {
    return reasoningEfforts.indexOf(effort)
  }
  return Math.ceil(((values.indexOf(value) + 1) / values.length) * segmentCount)
}

/** Toggle controls fill the ring for On, independent of their underlying native effort. */
export const EffortRing = ({
  value,
  values,
  kind,
}: {
  value: string | undefined
  values: readonly string[]
  kind?: ReasoningCapabilities['kind']
}) => {
  const gradientId = useId()
  if (value === undefined || !values.includes(value)) {
    return <Sparkles aria-hidden="true" className="size-[var(--icon-size-default)] shrink-0 text-muted-foreground" />
  }
  const filled = filledSegments(value, values, kind)
  return (
    <svg aria-hidden="true" viewBox="0 0 20 20" className="size-[var(--icon-size-default)] shrink-0" fill="none">
      <defs>
        <linearGradient id={gradientId} x1="0" y1="0" x2="20" y2="20" gradientUnits="userSpaceOnUse">
          <stop stopColor="var(--color-brand-2)" />
          <stop offset="1" stopColor="var(--color-brand)" />
        </linearGradient>
      </defs>
      {Array.from({ length: segmentCount }, (_, index) => (
        <circle
          key={index}
          cx="10"
          cy="10"
          r="7"
          pathLength="60"
          stroke={index < filled ? `url(#${gradientId})` : 'currentColor'}
          strokeOpacity={index < filled ? 1 : 0.25}
          strokeWidth="2.5"
          strokeLinecap="round"
          strokeDasharray="6 54"
          strokeDashoffset={13 - index * 10}
        />
      ))}
    </svg>
  )
}
