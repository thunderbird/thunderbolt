/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

const screenshots = {
  desktop: {
    width: 2800,
    height: 1700,
    alt: 'Thunderbolt planning a backyard star party with a Webb telescope photo story open beside the conversation',
  },
  mobile: {
    width: 408,
    height: 887,
    alt: 'Thunderbolt on mobile writing a playful invitation to a backyard star party',
  },
} as const

export const ThemedScreenshot = ({ platform }: { platform: keyof typeof screenshots }) => (
  <div className="spark-themed-screenshot">
    {(['light', 'dark'] as const).map((theme) => (
      <img
        key={theme}
        data-screenshot-theme={theme}
        src={`/images/marketing/screenshots/${platform}-${theme}.webp`}
        {...screenshots[platform]}
        fetchPriority={platform === 'desktop' ? 'high' : 'auto'}
        decoding="async"
      />
    ))}
  </div>
)
