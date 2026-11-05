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

export const ThemedScreenshot = ({ platform }: { platform: keyof typeof screenshots }) => {
  const imageProps = {
    ...screenshots[platform],
    fetchPriority: platform === 'desktop' ? ('high' as const) : ('auto' as const),
    decoding: 'async' as const,
  }
  const light = `/images/marketing/screenshots/${platform}-light.webp`
  const dark = `/images/marketing/screenshots/${platform}-dark.webp`

  // Development can preview a theme independently of the OS.
  if (import.meta.env.DEV) {
    return (
      <div className="spark-themed-screenshot">
        <img data-screenshot-theme="light" src={light} {...imageProps} />
        <img data-screenshot-theme="dark" src={dark} {...imageProps} />
      </div>
    )
  }

  return (
    <picture className="spark-themed-screenshot">
      <source media="(prefers-color-scheme: dark)" srcSet={dark} />
      <img src={light} {...imageProps} />
    </picture>
  )
}
