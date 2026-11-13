/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

type SparkBurstProps = {
  className?: string
  symbol?: 'bolt' | 'lock'
}

export const SparkBurst = ({ className = '', symbol = 'bolt' }: SparkBurstProps) => {
  return (
    <svg className={className} viewBox="0 0 240 240" fill="none" aria-hidden="true">
      <path
        d="M116.51 11.58Q120.00 8.00 123.49 11.58 L141.46 29.96Q143.55 32.10 146.44 31.29 L171.19 24.35Q176.00 23.01 177.24 27.85 L183.60 52.75Q184.35 55.65 187.25 56.40 L212.15 62.76Q216.99 64.00 215.65 68.81 L208.71 93.56Q207.90 96.45 210.04 98.54 L228.42 116.51Q232.00 120.00 228.42 123.49 L210.04 141.46Q207.90 143.55 208.71 146.44 L215.65 171.19Q216.99 176.00 212.15 177.24 L187.25 183.60Q184.35 184.35 183.60 187.25 L177.24 212.15Q176.00 216.99 171.19 215.65 L146.44 208.71Q143.55 207.90 141.46 210.04 L123.49 228.42Q120.00 232.00 116.51 228.42 L98.54 210.04Q96.45 207.90 93.56 208.71 L68.81 215.65Q64.00 216.99 62.76 212.15 L56.40 187.25Q55.65 184.35 52.75 183.60 L27.85 177.24Q23.01 176.00 24.35 171.19 L31.29 146.44Q32.10 143.55 29.96 141.46 L11.58 123.49Q8.00 120.00 11.58 116.51 L29.96 98.54Q32.10 96.45 31.29 93.56 L24.35 68.81Q23.01 64.00 27.85 62.76 L52.75 56.40Q55.65 55.65 56.40 52.75 L62.76 27.85Q64.00 23.01 68.81 24.35 L93.56 31.29Q96.45 32.10 98.54 29.96Z"
        fill="var(--spark-badge-fill)"
      />
      {symbol === 'lock' ? (
        <g>
          <path
            d="M96 112V96a24 24 0 0 1 48 0v16"
            stroke="var(--spark-badge-ink)"
            strokeWidth="8"
            strokeLinecap="round"
          />
          <path
            d="M94 108h52a12 12 0 0 1 12 12v42a12 12 0 0 1-12 12H94a12 12 0 0 1-12-12v-42a12 12 0 0 1 12-12Z M120 126a7 7 0 0 0-4 12.75V150h8v-11.25A7 7 0 0 0 120 126Z"
            fill="var(--spark-badge-ink)"
            fillRule="evenodd"
          />
        </g>
      ) : (
        <path d="m140 66-53 61h34l-21 47 53-61h-34Z" fill="var(--spark-badge-ink)" />
      )}
    </svg>
  )
}
