/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/** Pair each optimized recording with its static fallback. */
const asset = (name: string) => ({
  src: `/videos/marketing/${name}.mp4`,
  poster: `/images/marketing/screenshots/${name}.webp`,
})

export const productDemos = {
  desktop: {
    width: 1920,
    height: 1166,
    // Source-pixel mask includes the native corner’s encoded black fringe.
    cornerRadius: 36,
    description: 'Thunderbolt develops an idea in chat, then opens a Webb telescope photo story in its side browser.',
    light: asset('desktop-light'),
    dark: asset('desktop-dark'),
  },
  mobile: {
    width: 784,
    height: 1536,
    description: 'Thunderbolt on a phone helps with everyday ideas and planning a neighborhood seed-sharing app.',
    light: asset('mobile-light'),
    dark: asset('mobile-dark'),
  },
  terminal: {
    width: 1600,
    height: 720,
    description: 'The Thunderbolt CLI writes a small focus-planning tool, runs it, and verifies its output.',
    light: asset('terminal'),
    dark: asset('terminal'),
  },
} as const

export type DemoPlatform = keyof typeof productDemos
