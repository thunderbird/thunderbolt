/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

export const SparkBurst = ({ className = '' }: { className?: string }) => (
  <svg className={className} viewBox="0 0 240 240" fill="none" aria-hidden="true">
    <polygon
      points="120.00,4.00 142.26,36.93 178.00,19.54 180.81,59.19 220.46,62.00 203.07,97.74 236.00,120.00 203.07,142.26 220.46,178.00 180.81,180.81 178.00,220.46 142.26,203.07 120.00,236.00 97.74,203.07 62.00,220.46 59.19,180.81 19.54,178.00 36.93,142.26 4.00,120.00 36.93,97.74 19.54,62.00 59.19,59.19 62.00,19.54 97.74,36.93"
      fill="currentColor"
    />
    <circle cx="120" cy="120" r="52" stroke="var(--spark-graphic-ink)" strokeWidth="1.25" />
    <path d="M129 82 96 125h25l-10 33 33-43h-25Z" fill="var(--spark-graphic-ink)" />
  </svg>
)
