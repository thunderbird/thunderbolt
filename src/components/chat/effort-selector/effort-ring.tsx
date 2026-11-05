/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useId } from 'react'
import { Sparkles } from 'lucide-react'

const levels: Record<string, number> = { none: 0, off: 0, minimal: 1, low: 2, medium: 3, high: 4, xhigh: 5, max: 6 }

/** Six fixed segments distinguish every native effort; unknown ACP values follow the agent's ordering. */
export const EffortRing = ({ value, values }: { value: string | undefined; values: string[] }) => {
  const gradientId = useId()
  if (!value || value === 'default') {
    return <Sparkles aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
  }
  const ranked = values.filter((item) => item !== 'default')
  const filled = Object.hasOwn(levels, value)
    ? levels[value]!
    : Math.max(1, Math.ceil(((ranked.indexOf(value) + 1) / ranked.length) * 6))
  return (
    <svg aria-hidden="true" viewBox="0 0 20 20" className="size-4 shrink-0" fill="none">
      <defs>
        <linearGradient id={gradientId} x1="0" y1="0" x2="20" y2="20" gradientUnits="userSpaceOnUse">
          <stop stopColor="var(--color-brand-2)" />
          <stop offset="1" stopColor="var(--color-brand)" />
        </linearGradient>
      </defs>
      {Array.from({ length: 6 }, (_, index) => (
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
