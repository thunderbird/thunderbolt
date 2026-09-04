/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Minimal, dependency-free ANSI styling for the thunderbolt CLI's terminal
 * renderer. Brand colors use truecolor when advertised, 256-color otherwise,
 * and remain plain for NO_COLOR or redirected output.
 */

const palette = {
  brandStart: '#d99a4e',
  brandEnd: '#e0568c',
  bolt: '#f2c94c',
  link: '#56b6c2',
  success: '#8ec07c',
  error: '#e06c75',
  secondary: '#6f7486',
  overlay: '#1e222c',
} as const

type ColorMode = 'plain' | 'ansi256' | 'truecolor'
type Rgb = readonly [red: number, green: number, blue: number]

/** Selects the richest terminal color mode currently available. */
const terminalColorMode = (): ColorMode => {
  if (process.env.NO_COLOR || !process.stdout.isTTY) return 'plain'
  return /^(truecolor|24bit)$/i.test(process.env.COLORTERM ?? '') ? 'truecolor' : 'ansi256'
}

const colorMode = terminalColorMode()

/** Parses a validated six-digit design token. */
const parseHex = (hex: string): Rgb => [
  Number.parseInt(hex.slice(1, 3), 16),
  Number.parseInt(hex.slice(3, 5), 16),
  Number.parseInt(hex.slice(5, 7), 16),
]

/** Squared RGB distance used only for nearest xterm palette selection. */
const colorDistance = (left: Rgb, right: Rgb): number =>
  left.reduce((total, channel, index) => total + (channel - right[index]!) ** 2, 0)

/** Finds the nearest stable xterm cube/gray entry (system colors vary by terminal). */
const ansi256Index = (rgb: Rgb): number => {
  const cubeChannels = rgb.map((channel) => Math.round(channel / 51)) as [number, number, number]
  const cubeRgb = cubeChannels.map((channel) => channel * 51) as [number, number, number]
  const cubeIndex = 16 + 36 * cubeChannels[0] + 6 * cubeChannels[1] + cubeChannels[2]
  const average = rgb.reduce((total, channel) => total + channel, 0) / rgb.length
  const grayLevel = Math.max(0, Math.min(23, Math.round((average - 8) / 10)))
  const grayRgb = [8 + grayLevel * 10, 8 + grayLevel * 10, 8 + grayLevel * 10] as const
  return colorDistance(rgb, grayRgb) < colorDistance(rgb, cubeRgb) ? 232 + grayLevel : cubeIndex
}

/** Builds one foreground SGR opener for the selected terminal mode. */
const foregroundOpen = (rgb: Rgb, mode: Exclude<ColorMode, 'plain'>): string =>
  mode === 'truecolor' ? `\x1b[38;2;${rgb.join(';')}m` : `\x1b[38;5;${ansi256Index(rgb)}m`

/** Builds one background SGR opener for the selected terminal mode. */
const backgroundOpen = (rgb: Rgb, mode: Exclude<ColorMode, 'plain'>): string =>
  mode === 'truecolor' ? `\x1b[48;2;${rgb.join(';')}m` : `\x1b[48;5;${ansi256Index(rgb)}m`

/**
 * Builds a styling helper that wraps text in an ANSI SGR sequence, returning
 * the text unchanged when color is disabled.
 *
 * @param open - the opening SGR escape (e.g. `\x1b[36m` for cyan)
 * @returns a helper that styles a string and resets afterwards
 */
const style =
  (open: string) =>
  (text: string): string =>
    colorMode === 'plain' ? text : `${open}${text}\x1b[0m`

/** Builds a foreground helper from one approved hex token. */
const color =
  (hex: string) =>
  (text: string): string =>
    colorMode === 'plain' ? text : `${foregroundOpen(parseHex(hex), colorMode)}${text}\x1b[0m`

export const dim = style('\x1b[2m')
export const cyan = color(palette.link)
export const amber = color(palette.brandStart)
export const raspberry = color(palette.brandEnd)
export const boltYellow = color(palette.bolt)
export const green = color(palette.success)
export const red = color(palette.error)
export const gray = color(palette.secondary)
export const bold = style('\x1b[1m')
export const italic = style('\x1b[3m')
export const underline = style('\x1b[4m')
export const strikethrough = style('\x1b[9m')

/** Applies the approved amber-to-raspberry gradient per character. */
export const brandGradient = (text: string, mode: ColorMode = colorMode): string => {
  if (mode === 'plain' || text.length === 0) return text
  const characters = [...text]
  const start = parseHex(palette.brandStart)
  const end = parseHex(palette.brandEnd)
  const interpolate = (from: number, to: number, index: number): number =>
    Math.round(from + (to - from) * (characters.length === 1 ? 1 : index / (characters.length - 1)))
  return `${characters
    .map((character, index) => {
      const rgb = start.map((channel, channelIndex) => interpolate(channel, end[channelIndex]!, index)) as [
        number,
        number,
        number,
      ]
      return `${foregroundOpen(rgb, mode)}${character}`
    })
    .join('')}\x1b[0m`
}

/** Applies the approved background tint to an overlay row. */
export const overlayBackground = (text: string): string =>
  colorMode === 'plain' ? text : `${backgroundOpen(parseHex(palette.overlay), colorMode)}${text}\x1b[0m`

/** Renders the reserved bolt-yellow status spark. */
export const spark = (): string => boltYellow(symbols.spark)

/** Two restrained frames for pi-tui Loader indicators. */
export const sparkFrames = (): string[] => [spark(), dim(spark())]

/** Glyphs marking tool activity in the streamed output. */
export const symbols = {
  /** Precedes a tool invocation. */
  tool: '⏺',
  /** Marks a successful tool result. */
  ok: '✓',
  /** Marks a failed tool result. */
  fail: '✗',
  /** Brand and status spark. */
  spark: '⚡',
  /** Thinking label. */
  thinking: '∴',
  /** Interrupted turn marker. */
  interrupted: '✻',
} as const
