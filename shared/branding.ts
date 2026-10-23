/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Operator branding as `GET /config` carries it, declared and validated once
 * for both ends.
 *
 * The token vocabulary is shadcn's (`cssVars.theme` / `light` / `dark`, kebab
 * keys), so a theme exported from tweakcn or the shadcn theme gallery can be
 * pasted as-is; keys those exports carry that we don't apply (spacing,
 * precomputed shadows) are accepted and dropped. The backend reads it from
 * `BRANDING_JSON` today; an admin dashboard will store it later behind the
 * same shape. Like `mini-app-registry.ts`, this module stays free of
 * third-party imports — the backend Docker image installs only
 * `backend/node_modules`. See docs/internals/architecture/branding.md.
 */

import { httpUrlMessage, isHttpUrl } from './mini-app-registry'

export const brandingThemeModes = ['light', 'dark', 'system'] as const
export type BrandingThemeMode = (typeof brandingThemeModes)[number]

/** shadcn's semantic colors, then the tokens only Thunderbolt has. Each maps to `--color-<key>`. */
export const brandingColorTokens = [
  'background',
  'foreground',
  'card',
  'card-foreground',
  'popover',
  'popover-foreground',
  'primary',
  'primary-foreground',
  'secondary',
  'secondary-foreground',
  'muted',
  'muted-foreground',
  'accent',
  'accent-foreground',
  'destructive',
  'destructive-foreground',
  'border',
  'input',
  'ring',
  'chart-1',
  'chart-2',
  'chart-3',
  'chart-4',
  'chart-5',
  'sidebar',
  'sidebar-foreground',
  'sidebar-primary',
  'sidebar-primary-foreground',
  'sidebar-accent',
  'sidebar-accent-foreground',
  'sidebar-border',
  'sidebar-ring',
  'brand',
  'brand-secondary',
  'brand-foreground',
  'border-strong',
  'success',
  'success-foreground',
  'warning',
  'warning-foreground',
] as const
export type BrandingColorToken = (typeof brandingColorTokens)[number]

/** tweakcn's shadow parameters; the client generates the whole shadow scale from them. */
export const brandingShadowTokens = [
  'shadow-color',
  'shadow-opacity',
  'shadow-blur',
  'shadow-spread',
  'shadow-offset-x',
  'shadow-offset-y',
] as const
export type BrandingShadowToken = (typeof brandingShadowTokens)[number]

/** Font slots: shadcn's three plus our display headings. Each maps to `--font-<slot>`. */
export const brandingFontTokens = ['font-sans', 'font-serif', 'font-mono', 'font-heading'] as const
export type BrandingFontToken = (typeof brandingFontTokens)[number]

/** Mode-independent tokens. Accepted in `light`/`dark` too, because tweakcn repeats them there. */
export const brandingLayoutTokens = ['radius', 'letter-spacing', ...brandingFontTokens] as const
export type BrandingLayoutToken = (typeof brandingLayoutTokens)[number]

/**
 * Keys shadcn/tweakcn exports carry that Thunderbolt does not apply, accepted
 * so an export pastes cleanly and stripped during parsing. `spacing` would
 * resize every touch target, and the precomputed shadows are regenerated from
 * the shadow parameters instead of trusted as raw CSS.
 */
const ignoredTokens = new Set([
  'spacing',
  'tracking-normal',
  'tracking-tighter',
  'tracking-tight',
  'tracking-wide',
  'tracking-wider',
  'tracking-widest',
  'shadow',
  'shadow-2xs',
  'shadow-xs',
  'shadow-sm',
  'shadow-md',
  'shadow-lg',
  'shadow-xl',
  'shadow-2xl',
])

export type BrandingModeTokens = Partial<Record<BrandingColorToken | BrandingShadowToken | BrandingLayoutToken, string>>
export type BrandingThemeTokens = Partial<Record<BrandingLayoutToken, string>>

/** Operator-owned destinations; each falls back to Thunderbolt's own when unset. */
export type BrandingLinks = {
  privacyPolicy?: string
  termsOfService?: string
  /** An http(s) page or a `mailto:` address. */
  support?: string
}

/** HTTPS image URLs the backend downloads at startup and serves itself. `dark` falls back to `light`. */
export type BrandingLogo = {
  light: string
  dark?: string
}

export type Branding = {
  appName?: string
  /** Theme for users who never picked one. */
  defaultThemeMode?: BrandingThemeMode
  links?: BrandingLinks
  logo?: BrandingLogo
  cssVars?: {
    theme?: BrandingThemeTokens
    light?: BrandingModeTokens
    dark?: BrandingModeTokens
  }
}

export const appNameMaxLength = 60

/** The name the app shows when the operator sets none. */
export const defaultAppName = 'Thunderbolt'

const hexColorPattern = /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i
// Function arguments limited to numbers, separators, `deg` and `none`: nothing
// that can close the declaration or open another one.
const functionColorPattern = /^(?:rgba?|hsla?|oklch|oklab)\((?:[\d.\s%,/+-]|deg|none)+\)$/i
const lengthPattern = /^-?(?:\d+|\d*\.\d+)(?:px|rem|em)?$/
const opacityPattern = /^(?:\d+|\d*\.\d+)$/

/**
 * True for a hex color or an `rgb()`/`hsl()`/`oklch()`/`oklab()` call with
 * plain numeric arguments. Branding values are written into a stylesheet, so
 * nothing else survives the check on either end.
 *
 * @param value - Candidate color, from operator config or the wire.
 */
export const isCssColor = (value: string): boolean => hexColorPattern.test(value) || functionColorPattern.test(value)

/**
 * True for a unitless zero-or-number or a `px`/`rem`/`em` length, negative allowed.
 *
 * @param value - Candidate length.
 */
export const isCssLength = (value: string): boolean => lengthPattern.test(value)

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const fontNamePattern = /^[A-Za-z0-9 _-]+$/

/**
 * Split a CSS `font-family` list into bare family names, or null when any name
 * holds more than letters, digits, spaces, hyphens and underscores. Quotes are
 * stripped here and re-added on output, so no operator-written quote ever
 * reaches the stylesheet.
 *
 * @param value - A list such as `"DM Sans", ui-sans-serif, sans-serif`.
 */
export const parseFontFamilies = (value: string): string[] | null => {
  const names = value.split(',').map((part) =>
    part
      .trim()
      .replace(/^(['"])(.*)\1$/, '$2')
      .trim(),
  )
  return names.length > 0 && names.every((name) => fontNamePattern.test(name)) ? names : null
}

/** CSS generic and system-keyword families: never downloadable, always available. */
const genericFontFamilies = new Set([
  'serif',
  'sans-serif',
  'monospace',
  'cursive',
  'fantasy',
  'system-ui',
  'ui-serif',
  'ui-sans-serif',
  'ui-monospace',
  'ui-rounded',
  'math',
  'emoji',
  'fangsong',
  '-apple-system',
  'BlinkMacSystemFont',
])

/**
 * True for a generic or system-keyword family (`sans-serif`, `ui-monospace`, …).
 *
 * @param name - A bare family name.
 */
export const isGenericFontFamily = (name: string): boolean => genericFontFamilies.has(name)

/**
 * The family names each font slot is set to, mode-independent: `theme` wins,
 * then `light`, then `dark`, because tweakcn repeats fonts in every block.
 *
 * @param branding - Validated branding.
 */
export const brandingFontFamilies = (branding: Branding | undefined): Partial<Record<BrandingFontToken, string[]>> => {
  const { theme = {}, light = {}, dark = {} } = branding?.cssVars ?? {}
  return Object.fromEntries(
    brandingFontTokens.flatMap((slot) => {
      const value = theme[slot] ?? light[slot] ?? dark[slot]
      const names = value ? parseFontFamilies(value) : null
      return names ? [[slot, names]] : []
    }),
  )
}

/**
 * One downloadable font face as `GET /config` lists it under `brandingFonts`.
 * The backend fetches the faces from Google Fonts at startup and serves the
 * files itself at `config/fonts/<file>`, so users' browsers never contact a
 * third party.
 */
export type BrandingFontFace = {
  family: string
  style: 'normal' | 'italic'
  /** A weight or a variable range, e.g. `400` or `100 900`. */
  weight: string
  unicodeRange: string
  /** Content-addressed file name under `config/fonts/`. */
  file: string
}

const fontWeightPattern = /^\d{1,3}(?: \d{1,3})?$/
const unicodeRangePattern = /^U\+[0-9A-F?]+(?:-[0-9A-F]+)?(?:, ?U\+[0-9A-F?]+(?:-[0-9A-F]+)?)*$/i
const fontFilePattern = /^[a-f0-9]{16,64}\.woff2$/

/**
 * Whether a wire value is a well-formed {@link BrandingFontFace}. Its fields
 * become `FontFace` descriptors and a request path, so each is pattern-checked.
 *
 * @param value - One entry of `brandingFonts` from `/config`.
 */
export const isBrandingFontFace = (value: unknown): value is BrandingFontFace =>
  isRecord(value) &&
  typeof value.family === 'string' &&
  fontNamePattern.test(value.family) &&
  (value.style === 'normal' || value.style === 'italic') &&
  typeof value.weight === 'string' &&
  fontWeightPattern.test(value.weight) &&
  typeof value.unicodeRange === 'string' &&
  unicodeRangePattern.test(value.unicodeRange) &&
  typeof value.file === 'string' &&
  fontFilePattern.test(value.file)

const tokenRule = (key: string): ((value: string) => string | null) | undefined => {
  if ((brandingColorTokens as readonly string[]).includes(key) || key === 'shadow-color') {
    return (value) => (isCssColor(value) ? null : 'must be a hex, rgb(), hsl(), oklch() or oklab() color')
  }
  if (key === 'shadow-opacity') {
    return (value) => (opacityPattern.test(value) && Number(value) <= 1 ? null : 'must be a number from 0 to 1')
  }
  if (key === 'radius') {
    return (value) => (isCssLength(value) && !value.startsWith('-') ? null : 'must be a non-negative px or rem length')
  }
  if ((brandingFontTokens as readonly string[]).includes(key)) {
    return (value) =>
      parseFontFamilies(value)
        ? null
        : 'must be a comma-separated list of font names (letters, digits, spaces, hyphens)'
  }
  if ((brandingShadowTokens as readonly string[]).includes(key) || key === 'letter-spacing') {
    return (value) => (isCssLength(value) ? null : 'must be a px, rem or em length')
  }
  return undefined
}

const parseTokens = (
  input: unknown,
  path: string,
  allowed: (key: string) => boolean,
  errors: string[],
): Record<string, string> | undefined => {
  if (input === undefined) {
    return undefined
  }
  if (!isRecord(input)) {
    errors.push(`${path}: must be an object`)
    return undefined
  }
  const tokens: Record<string, string> = {}
  for (const [key, raw] of Object.entries(input)) {
    if (ignoredTokens.has(key)) {
      continue
    }
    const rule = allowed(key) ? tokenRule(key) : undefined
    if (!rule) {
      errors.push(`${path}.${key}: unknown token`)
      continue
    }
    // tweakcn writes numbers as strings ("1"); accept real numbers too.
    const value = typeof raw === 'number' ? String(raw) : raw
    if (typeof value !== 'string') {
      errors.push(`${path}.${key}: must be a string`)
      continue
    }
    const problem = rule(value.trim())
    if (problem) {
      errors.push(`${path}.${key}: ${problem}`)
      continue
    }
    tokens[key] = value.trim()
  }
  return tokens
}

const isLayoutToken = (key: string) => (brandingLayoutTokens as readonly string[]).includes(key)
const isModeToken = (key: string) => tokenRule(key) !== undefined

const isMailtoUrl = (value: string): boolean => URL.canParse(value) && new URL(value).protocol === 'mailto:'

const linkRules: Record<keyof BrandingLinks, { accepts: (value: string) => boolean; message: string }> = {
  privacyPolicy: { accepts: isHttpUrl, message: httpUrlMessage },
  termsOfService: { accepts: isHttpUrl, message: httpUrlMessage },
  support: {
    accepts: (value) => isHttpUrl(value) || isMailtoUrl(value),
    message: 'must be an http(s) URL or a mailto: address',
  },
}

// The values become `href`s, so only http(s) (and mailto: for support) pass:
// no `javascript:` or `data:` link can reach the page.
const parseLinks = (input: unknown, errors: string[]): BrandingLinks | undefined => {
  if (!isRecord(input)) {
    errors.push('links: must be an object')
    return undefined
  }
  const links: BrandingLinks = {}
  for (const [key, value] of Object.entries(input)) {
    const rule = key in linkRules ? linkRules[key as keyof BrandingLinks] : undefined
    if (!rule) {
      errors.push(`links.${key}: unknown key`)
      continue
    }
    if (typeof value !== 'string' || !rule.accepts(value.trim())) {
      errors.push(`links.${key}: ${rule.message}`)
      continue
    }
    links[key as keyof BrandingLinks] = value.trim()
  }
  return links
}

const isHttpsUrl = (value: string): boolean => URL.canParse(value) && new URL(value).protocol === 'https:'

const parseLogo = (input: unknown, errors: string[]): BrandingLogo | undefined => {
  if (!isRecord(input)) {
    errors.push('logo: must be an object')
    return undefined
  }
  const problems = errors.length
  for (const key of Object.keys(input)) {
    if (key !== 'light' && key !== 'dark') {
      errors.push(`logo.${key}: unknown key`)
    }
  }
  const url = (key: 'light' | 'dark') => {
    const value = input[key]
    if (typeof value === 'string' && isHttpsUrl(value.trim())) {
      return value.trim()
    }
    errors.push(`logo.${key}: must be an https URL`)
    return undefined
  }
  const light = url('light')
  const dark = input.dark === undefined ? undefined : url('dark')
  return errors.length === problems && light ? { light, ...(dark && { dark }) } : undefined
}

/** Image types a branding logo may be; each maps to the extension of its served file. */
export const brandingLogoTypes = {
  'image/svg+xml': 'svg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/jpeg': 'jpg',
} as const
export type BrandingLogoType = keyof typeof brandingLogoTypes

/** One downloaded logo, as `GET /config` lists it under `brandingLogo`; served at `config/logo/<file>`. */
export type BrandingLogoFile = { file: string; type: BrandingLogoType }

export type BrandingLogoManifest = { light: BrandingLogoFile; dark?: BrandingLogoFile }

const logoFilePattern = /^[a-f0-9]{16,64}\.(?:svg|png|webp|jpg)$/

const isBrandingLogoFile = (value: unknown): value is BrandingLogoFile =>
  isRecord(value) &&
  typeof value.file === 'string' &&
  logoFilePattern.test(value.file) &&
  typeof value.type === 'string' &&
  value.type in brandingLogoTypes

/**
 * Whether a wire value is a well-formed {@link BrandingLogoManifest}. The file
 * names become a request path, so each is pattern-checked.
 *
 * @param value - `brandingLogo` from `/config`.
 */
export const isBrandingLogoManifest = (value: unknown): value is BrandingLogoManifest =>
  isRecord(value) && isBrandingLogoFile(value.light) && (value.dark === undefined || isBrandingLogoFile(value.dark))

export type BrandingParseResult = { ok: true; branding: Branding } | { ok: false; errors: string[] }

/**
 * Validate branding from operator config or the wire, stripping the export
 * keys Thunderbolt ignores. Every problem is collected, so an operator fixes
 * the whole value in one pass.
 *
 * @param input - Parsed JSON.
 */
export const parseBranding = (input: unknown): BrandingParseResult => {
  if (!isRecord(input)) {
    return { ok: false, errors: ['branding must be a JSON object'] }
  }
  const errors: string[] = []
  const branding: Branding = {}

  for (const key of Object.keys(input)) {
    if (!['appName', 'defaultThemeMode', 'links', 'logo', 'cssVars'].includes(key)) {
      errors.push(`${key}: unknown key`)
    }
  }

  const { appName, defaultThemeMode, links, logo, cssVars } = input
  if (appName !== undefined) {
    const trimmed = typeof appName === 'string' ? appName.trim() : ''
    if (trimmed.length === 0 || trimmed.length > appNameMaxLength) {
      errors.push(`appName: must be a string of 1 to ${appNameMaxLength} characters`)
    } else {
      branding.appName = trimmed
    }
  }

  if (defaultThemeMode !== undefined) {
    if ((brandingThemeModes as readonly unknown[]).includes(defaultThemeMode)) {
      branding.defaultThemeMode = defaultThemeMode as BrandingThemeMode
    } else {
      errors.push(`defaultThemeMode: must be one of ${brandingThemeModes.join(', ')}`)
    }
  }

  if (links !== undefined) {
    const parsedLinks = parseLinks(links, errors)
    if (parsedLinks) {
      branding.links = parsedLinks
    }
  }

  if (logo !== undefined) {
    const parsedLogo = parseLogo(logo, errors)
    if (parsedLogo) {
      branding.logo = parsedLogo
    }
  }

  if (cssVars !== undefined) {
    if (!isRecord(cssVars)) {
      errors.push('cssVars: must be an object')
    } else {
      for (const key of Object.keys(cssVars)) {
        if (!['theme', 'light', 'dark'].includes(key)) {
          errors.push(`cssVars.${key}: unknown key`)
        }
      }
      const theme = parseTokens(cssVars.theme, 'cssVars.theme', isLayoutToken, errors)
      const light = parseTokens(cssVars.light, 'cssVars.light', isModeToken, errors)
      const dark = parseTokens(cssVars.dark, 'cssVars.dark', isModeToken, errors)
      branding.cssVars = {
        ...(theme && { theme }),
        ...(light && { light }),
        ...(dark && { dark }),
      }
    }
  }

  return errors.length > 0 ? { ok: false, errors } : { ok: true, branding }
}

/**
 * The radius scale multiplier for a shadcn `radius` length. shadcn's default
 * is 0.625rem, which is our scale 1; px assumes the 16px root.
 *
 * @param radius - A validated non-negative length.
 */
export const radiusScaleFor = (radius: string): number => {
  const amount = parseFloat(radius)
  const rem = radius.endsWith('px') ? amount / 16 : amount
  return Math.round((rem / 0.625) * 1000) / 1000
}

type Rgb = [number, number, number]

const clamp01 = (n: number) => Math.min(1, Math.max(0, n))

/** Splits a color function's arguments, dropping the alpha after `/` or a fourth comma value. */
const colorArguments = (value: string): string[] => {
  const inner = value.slice(value.indexOf('(') + 1, -1).split('/')[0]
  return inner
    .split(/[\s,]+/)
    .filter(Boolean)
    .slice(0, 3)
}

const fraction = (arg: string, scale: number) => (arg.endsWith('%') ? parseFloat(arg) / 100 : parseFloat(arg) / scale)

const hexToRgb = (hex: string): Rgb => {
  const digits = hex.slice(1)
  const full = digits.length <= 4 ? [...digits].map((d) => d + d).join('') : digits
  return [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16) / 255) as Rgb
}

const hslToRgb = ([h, s, l]: string[]): Rgb => {
  const hue = (((parseFloat(h) % 360) + 360) % 360) / 360
  const sat = fraction(s, 100)
  const light = fraction(l, 100)
  const channel = (n: number) => {
    const k = (n + hue * 12) % 12
    return light - sat * Math.min(light, 1 - light) * Math.max(-1, Math.min(k - 3, 9 - k, 1))
  }
  return [channel(0), channel(8), channel(4)]
}

const linearToSrgb = (c: number) => (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055)

const oklabToRgb = (l: number, a: number, b: number): Rgb => {
  const lCone = (l + 0.3963377774 * a + 0.2158037573 * b) ** 3
  const mCone = (l - 0.1055613458 * a - 0.0638541728 * b) ** 3
  const sCone = (l - 0.0894841775 * a - 1.291485548 * b) ** 3
  return [
    4.0767416621 * lCone - 3.3077115913 * mCone + 0.2309699292 * sCone,
    -1.2684380046 * lCone + 2.6097574011 * mCone - 0.3413193965 * sCone,
    -0.0041960863 * lCone - 0.7034186147 * mCone + 1.707614701 * sCone,
  ].map((c) => linearToSrgb(clamp01(c))) as Rgb
}

const toRgb = (color: string): Rgb | null => {
  if (color.startsWith('#')) {
    return hexToRgb(color)
  }
  const fn = color.slice(0, color.indexOf('(')).toLowerCase()
  const args = colorArguments(color)
  if (args.length < 3 || args.includes('none')) {
    return null
  }
  if (fn === 'rgb' || fn === 'rgba') {
    return args.map((arg) => clamp01(fraction(arg, 255))) as Rgb
  }
  if (fn === 'hsl' || fn === 'hsla') {
    return hslToRgb(args)
  }
  const lightness = fraction(args[0], 1)
  if (fn === 'oklch') {
    const chroma = parseFloat(args[1])
    const hue = (parseFloat(args[2]) * Math.PI) / 180
    return oklabToRgb(lightness, chroma * Math.cos(hue), chroma * Math.sin(hue))
  }
  return oklabToRgb(lightness, parseFloat(args[1]), parseFloat(args[2]))
}

const channelLuminance = (c: number): number => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)

const relativeLuminance = ([r, g, b]: Rgb): number =>
  0.2126 * channelLuminance(r) + 0.7152 * channelLuminance(g) + 0.0722 * channelLuminance(b)

const contrastRatio = (a: Rgb, b: Rgb): number => {
  const [lighter, darker] = [relativeLuminance(a), relativeLuminance(b)].sort((x, y) => y - x)
  return (lighter + 0.05) / (darker + 0.05)
}

/**
 * A validated branding color as `#rrggbb`, for surfaces that can't read modern
 * color syntax (email clients); null when it can't be evaluated. Alpha is dropped.
 *
 * @param color - A color that passed {@link isCssColor}.
 */
export const toHexColor = (color: string): string | null => {
  const rgb = toRgb(color)
  return rgb
    ? `#${rgb
        .map((channel) =>
          Math.round(clamp01(channel) * 255)
            .toString(16)
            .padStart(2, '0'),
        )
        .join('')}`
    : null
}

const lightInk = '#faf8f5'
const darkInk = '#262120'

/**
 * The theme's off-white or ink, whichever reads better on every given color,
 * or null when a color can't be evaluated (an argument of `none`).
 *
 * Takes several colors so text on a gradient is judged against its worst stop.
 *
 * @param backgrounds - Validated colors the text sits on.
 */
export const readableForeground = (...backgrounds: string[]): string | null => {
  const rgbs = backgrounds.map(toRgb)
  if (rgbs.some((rgb) => rgb === null)) {
    return null
  }
  const worst = (ink: string) => Math.min(...rgbs.map((rgb) => contrastRatio(hexToRgb(ink), rgb as Rgb)))
  return worst(lightInk) >= worst(darkInk) ? lightInk : darkInk
}
