/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// The deterministic layout sweep's cases: key screens in hard states, picked pairwise so every two values of any two
// dimensions meet in at least one case, instead of the whole product (8 × 3 × 3 × 2 = 144 cases). The web sweep is
// control/sweep.spec.ts, the native one scripts/sweep-native.ts.

export const sweepScreens = [
  'composer',
  'sidebar',
  'model-picker',
  'dialog',
  'settings',
  'attachment-viewer',
  'rich-reply',
  'loading',
] as const

export const sweepViewports = {
  desktop: { width: 1280, height: 800 },
  phone: { width: 390, height: 844 },
  // The smallest phone in use, held sideways is shorter still: narrow and short at once.
  'narrow-short': { width: 320, height: 480 },
} as const

export const sweepLocales = ['en', 'de', 'ja'] as const

/** `large` is the browser's default font size at 24 px instead of 16 px, Chrome's "Very large". */
export const sweepTexts = ['normal', 'large'] as const

export type SweepCase = {
  screen: (typeof sweepScreens)[number]
  viewport: keyof typeof sweepViewports
  locale: (typeof sweepLocales)[number]
  text: (typeof sweepTexts)[number]
}

const viewportNames = Object.keys(sweepViewports) as SweepCase['viewport'][]

/**
 * Every screen on every viewport, with the locale and text size stepping by `screen + viewport`. Locale (mod 3) and
 * text (mod 2) both follow that sum, which takes 10 consecutive values, so every locale meets every text size, and
 * each screen and each viewport meets every value of both.
 */
export const sweepCases: SweepCase[] = sweepScreens.flatMap((screen, s) =>
  viewportNames.map((viewport, v) => ({
    screen,
    viewport,
    locale: sweepLocales[(s + v) % sweepLocales.length],
    text: sweepTexts[(s + v) % sweepTexts.length],
  })),
)

/** The case's name: its test title and its baseline file. */
export const caseName = ({ screen, viewport, locale, text }: SweepCase) => `${screen}-${viewport}-${locale}-${text}`

const dimensions = {
  screen: sweepScreens,
  viewport: viewportNames,
  locale: sweepLocales,
  text: sweepTexts,
} as const

/**
 * The native sweep's states, in run order: one device size per platform, so the dimensions left are the ones only a
 * device has (the real keyboard, the system font size) and one language. `flow` names `control/sweep/<flow>.yaml`.
 * The app keeps the language it is switched to, so the German state runs last.
 */
export const nativeSweepStates = [
  { name: 'composer-keyboard', flow: 'composer-keyboard' },
  { name: 'sidebar', flow: 'sidebar' },
  { name: 'sheet', flow: 'sheet' },
  { name: 'settings', flow: 'settings' },
  { name: 'dialog', flow: 'dialog' },
  { name: 'reply', flow: 'reply' },
  // Android's WebView scales its text with the system font size, iOS's does not, so these run on Android only.
  { name: 'composer-keyboard-large', flow: 'composer-keyboard', large: true },
  { name: 'settings-large', flow: 'settings', large: true },
  { name: 'settings-de', flow: 'settings-de' },
] as const

export type NativeSweepState = (typeof nativeSweepStates)[number]

export const nativeStatesFor = (platform: 'ios' | 'android') =>
  nativeSweepStates.filter((state) => platform === 'android' || !('large' in state))

/** The pairs of dimension values no case covers, as `dim=value+dim=value`. Empty for a pairwise set. */
export const uncoveredPairs = (cases: SweepCase[]) => {
  const keys = Object.keys(dimensions) as (keyof SweepCase)[]
  return keys.flatMap((a, i) =>
    keys
      .slice(i + 1)
      .flatMap((b) =>
        dimensions[a].flatMap((x) =>
          dimensions[b].filter((y) => !cases.some((c) => c[a] === x && c[b] === y)).map((y) => `${a}=${x}+${b}=${y}`),
        ),
      ),
  )
}
