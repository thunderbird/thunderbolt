/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Operator branding, declared and validated once for both ends.
 *
 * The operator writes {@link Branding} in the `BRANDING` env var; the backend
 * validates it strictly at boot and serves {@link PublicBranding} as `branding`
 * in `GET /config` — the same value with the logo URLs swapped for the files
 * the backend downloaded, plus the font faces it resolved. The client
 * re-validates that leniently (see {@link parsePublicBranding}).
 *
 * The token vocabulary is shadcn's (`cssVars.theme` / `light` / `dark`, kebab
 * keys), so a theme exported from tweakcn or the shadcn theme gallery can be
 * pasted as-is; keys those exports carry that we don't apply (spacing, the
 * tracking scale, precomputed shadows) are accepted and dropped. An admin
 * dashboard will store the same shape later. Like `mini-app-registry.ts`, this
 * module stays free of third-party imports — the backend Docker image installs
 * only `backend/node_modules`. See docs/internals/architecture/branding.md.
 */

import { isRecord } from './lib/is-record'
import { hasProtocol, httpUrlMessage, isHttpUrl } from './url'

const brandingThemeModes = ['light', 'dark', 'system'] as const
type BrandingThemeMode = (typeof brandingThemeModes)[number]

/**
 * shadcn's semantic colors, then the tokens only Thunderbolt has. Each maps to
 * `--color-<key>`, except `brand-gradient-start`, which is `--color-brand-2`.
 */
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
  'brand-gradient-start',
  'brand-foreground',
  'border-strong',
  'success',
  'success-foreground',
  'warning',
  'warning-foreground',
] as const
export type BrandingColorToken = (typeof brandingColorTokens)[number]

/** tweakcn's shadow parameters; the client generates the whole shadow scale from them. */
type BrandingShadowToken =
  | 'shadow-color'
  | 'shadow-opacity'
  | 'shadow-blur'
  | 'shadow-spread'
  | 'shadow-offset-x'
  | 'shadow-offset-y'

/** Font slots: shadcn's three plus our display headings. Each is the name of its CSS variable (`--font-sans`). */
const brandingFontTokens = ['font-sans', 'font-serif', 'font-mono', 'font-heading'] as const
export type BrandingFontToken = (typeof brandingFontTokens)[number]

/** Mode-independent tokens: what `cssVars.theme` holds. Accepted in `light`/`dark` too, because tweakcn repeats them there. */
const brandingThemeTokens = ['radius', 'letter-spacing', ...brandingFontTokens] as const
type BrandingThemeToken = (typeof brandingThemeTokens)[number]

/**
 * Keys shadcn/tweakcn exports carry that Thunderbolt does not apply, accepted
 * so an export pastes cleanly and stripped during parsing. `spacing` would
 * resize every touch target; the `tracking-*` scale is derived from
 * `letter-spacing`, which is applied instead; and the precomputed shadows are
 * regenerated from the shadow parameters rather than trusted as raw CSS.
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

export type BrandingModeTokens = Partial<Record<BrandingColorToken | BrandingShadowToken | BrandingThemeToken, string>>

type BrandingCssVars = {
  theme?: Partial<Record<BrandingThemeToken, string>>
  light?: BrandingModeTokens
  dark?: BrandingModeTokens
}

/** Operator-owned destinations; each falls back to Thunderbolt's own when unset. */
export type BrandingLinks = {
  privacyPolicy?: string
  termsOfService?: string
  /** An http(s) page or a `mailto:` address. */
  support?: string
}

/** HTTPS image URLs the backend downloads at startup and serves itself. `dark` falls back to `light`. */
type BrandingLogoUrls = {
  light: string
  dark?: string
}

/** Branding as the operator writes it in `BRANDING`. */
export type Branding = {
  appName?: string
  /**
   * Who receives shared debug transcripts, shown as "the {name} team": whoever
   * runs the intake at `DEBUG_TRANSCRIPT_UPSTREAM_URL`. Defaults to Thunderbolt,
   * whose intake that usually is — not to the app name.
   */
  debugTranscriptRecipient?: string
  /** Theme for users who never picked one. */
  defaultThemeMode?: BrandingThemeMode
  links?: BrandingLinks
  logo?: BrandingLogoUrls
  cssVars?: BrandingCssVars
}

/**
 * One downloadable font face. The backend fetches the faces from Google Fonts
 * at startup and serves the files itself at `config/branding/<file>`, so
 * users' browsers never contact a third party.
 */
export type BrandingFontFace = {
  family: string
  style: 'normal' | 'italic'
  /** A weight or a variable range, e.g. `400` or `100 900`. */
  weight: string
  unicodeRange: string
  /** Content-addressed file name under `config/branding/`. */
  file: string
}

/** Image types a branding logo may be; each maps to the extension of its served file. */
export const brandingLogoTypes = {
  'image/svg+xml': 'svg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/jpeg': 'jpg',
} as const
type BrandingLogoType = keyof typeof brandingLogoTypes

/** One downloaded logo, served at `/config/branding/<file>`. */
export type BrandingLogoFile = { file: string; type: BrandingLogoType }

export type BrandingLogoManifest = { light: BrandingLogoFile; dark?: BrandingLogoFile }

/**
 * The operator fields `GET /config` publishes. Listed rather than derived, so
 * a field added to `Branding` stays server-side until someone decides it is public.
 */
const publicFields = ['appName', 'debugTranscriptRecipient', 'defaultThemeMode', 'links', 'cssVars'] as const

/** Branding as `GET /config` serves it: the public fields, the logo as downloaded files, and the resolved font faces. */
export type PublicBranding = Pick<Branding, (typeof publicFields)[number]> & {
  fonts?: BrandingFontFace[]
  logo?: BrandingLogoManifest
}

/**
 * The public projection of the operator's branding, with the files the backend
 * downloaded in place of the logo URLs.
 *
 * @param branding - The validated `BRANDING`.
 * @param files - The font faces and logo manifest downloaded so far.
 */
export const toPublicBranding = (
  branding: Branding,
  files: { fonts?: BrandingFontFace[]; logo?: BrandingLogoManifest },
): PublicBranding => {
  // Every public field required here, so one added to `publicFields` fails to compile until it is projected.
  const fields: { [Field in (typeof publicFields)[number]]: Branding[Field] } = {
    appName: branding.appName,
    debugTranscriptRecipient: branding.debugTranscriptRecipient,
    defaultThemeMode: branding.defaultThemeMode,
    links: branding.links,
    cssVars: branding.cssVars,
  }
  return { ...fields, fonts: files.fonts, logo: files.logo }
}

const nameMaxLength = 60

/** The name the app shows when the operator sets none. */
const defaultAppName = 'Thunderbolt'

/**
 * The deployment's app name: the operator's, else Thunderbolt.
 *
 * @param branding - Validated branding, either shape.
 */
export const resolveAppName = (branding: Pick<Branding, 'appName'> | undefined): string =>
  branding?.appName ?? defaultAppName

/** The transcript recipient when the operator names none: Thunderbolt runs the default intake. */
const defaultDebugTranscriptRecipient = 'Thunderbolt'

/**
 * Who receives shared debug transcripts: the operator's name for them, else Thunderbolt.
 *
 * @param branding - Validated branding, either shape.
 */
export const resolveDebugTranscriptRecipient = (
  branding: Pick<Branding, 'debugTranscriptRecipient'> | undefined,
): string => branding?.debugTranscriptRecipient ?? defaultDebugTranscriptRecipient

const hexColorPattern = /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i
// Function arguments limited to numbers, separators, `deg` and `none`: nothing
// that can close the declaration or open another one.
const functionColorPattern = /^(?:rgba?|hsla?|oklch|oklab)\((?:[\d.\s%,/+-]|deg|none)+\)$/i
// A unit is required: a bare number is invalid in box-shadow, letter-spacing and calc().
const lengthPattern = /^-?(?:\d+|\d*\.\d+)(?:px|rem|em)$/
const unitlessZeroPattern = /^-?(?:0+|0*\.0+)$/
const radiusPattern = /^(?:\d+|\d*\.\d+)(?:px|rem)$/
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
 * True for a `px`/`rem`/`em` length, negative allowed, or a bare zero.
 *
 * @param value - Candidate length.
 */
export const isCssLength = (value: string): boolean => lengthPattern.test(value) || unitlessZeroPattern.test(value)

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
  return names.every((name) => fontNamePattern.test(name)) ? names : null
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
 * A mode-independent token: `theme` wins, then `light`, then `dark`, because
 * tweakcn repeats these in every block.
 *
 * @param branding - Validated branding, either shape.
 * @param token - The token to read.
 */
export const brandingThemeToken = (
  branding: Pick<Branding, 'cssVars'> | undefined,
  token: BrandingThemeToken,
): string | undefined => {
  const { theme = {}, light = {}, dark = {} } = branding?.cssVars ?? {}
  return theme[token] ?? light[token] ?? dark[token]
}

/**
 * The family names each font slot is set to.
 *
 * @param branding - Validated branding, either shape.
 */
export const fontFamiliesBySlot = (
  branding: Pick<Branding, 'cssVars'> | undefined,
): Partial<Record<BrandingFontToken, string[]>> =>
  Object.fromEntries(
    brandingFontTokens.flatMap((slot) => {
      const value = brandingThemeToken(branding, slot)
      return value ? [[slot, parseFontFamilies(value) ?? []]] : []
    }),
  )

type TokenRule = {
  accepts: (value: string) => boolean
  message: string
  /** Rewrites an accepted value into the form the stylesheet needs. */
  normalize?: (value: string) => string
}

const colorRule: TokenRule = {
  accepts: isCssColor,
  message: 'must be a hex, rgb(), hsl(), oklch() or oklab() color',
}
// A bare zero becomes 0px, since `calc(0 - 1px)` (the layered shadows) is invalid.
const lengthRule: TokenRule = {
  accepts: isCssLength,
  message: 'must be a px, rem or em length (only 0 may omit the unit)',
  normalize: (value) => (unitlessZeroPattern.test(value) ? '0px' : value),
}
const radiusRule: TokenRule = {
  accepts: (value) => radiusPattern.test(value) || (unitlessZeroPattern.test(value) && !value.startsWith('-')),
  message: 'must be a non-negative px or rem length',
  normalize: lengthRule.normalize,
}
const opacityRule: TokenRule = {
  accepts: (value) => opacityPattern.test(value) && Number(value) <= 1,
  message: 'must be a number from 0 to 1',
}
const fontRule: TokenRule = {
  accepts: (value) => parseFontFamilies(value) !== null,
  message: 'must be a comma-separated list of font names (letters, digits, spaces, hyphens, underscores)',
}

// A Map, not an object literal: a key like `constructor` must not find a rule on the prototype.
const tokenRules = new Map<string, TokenRule>([
  ...brandingColorTokens.map((token): [string, TokenRule] => [token, colorRule]),
  ['shadow-color', colorRule],
  ['shadow-opacity', opacityRule],
  ['shadow-blur', lengthRule],
  ['shadow-spread', lengthRule],
  ['shadow-offset-x', lengthRule],
  ['shadow-offset-y', lengthRule],
  ['letter-spacing', lengthRule],
  ['radius', radiusRule],
  ...brandingFontTokens.map((token): [string, TokenRule] => [token, fontRule]),
])

const themeTokenSet = new Set<string>(brandingThemeTokens)

// tweakcn writes numbers as strings ("1"); accept real numbers too.
const tokenValue = (raw: unknown): string | undefined => {
  if (typeof raw === 'number') {
    return String(raw)
  }
  return typeof raw === 'string' ? raw.trim() : undefined
}

const rejectUnknownKeys = (
  input: Record<string, unknown>,
  allowed: readonly string[],
  path: string,
  issues: string[],
) => {
  for (const key of Object.keys(input)) {
    if (!allowed.includes(key)) {
      issues.push(`${path}${key}: unknown key`)
    }
  }
}

/**
 * What index.html's pre-paint script repeats (it runs before any module loads),
 * exported so a test keeps the two copies identical.
 */
export const prePaintRules = {
  hexColorPattern,
  functionColorPattern,
  nameMaxLength,
  themeModes: brandingThemeModes,
}

const parseTokens = (
  input: unknown,
  path: string,
  allowed: (key: string) => boolean,
  issues: string[],
): Record<string, string> | undefined => {
  if (input === undefined) {
    return undefined
  }
  if (!isRecord(input)) {
    issues.push(`${path}: must be an object`)
    return undefined
  }
  const tokens: Record<string, string> = {}
  for (const [key, raw] of Object.entries(input)) {
    if (ignoredTokens.has(key)) {
      continue
    }
    const rule = allowed(key) ? tokenRules.get(key) : undefined
    if (!rule) {
      issues.push(`${path}.${key}: unknown token`)
      continue
    }
    const value = tokenValue(raw)
    if (value === undefined || !rule.accepts(value)) {
      issues.push(`${path}.${key}: ${rule.message}`)
      continue
    }
    tokens[key] = rule.normalize ? rule.normalize(value) : value
  }
  return tokens
}

const parseCssVars = (input: unknown, issues: string[]): BrandingCssVars | undefined => {
  if (input === undefined) {
    return undefined
  }
  if (!isRecord(input)) {
    issues.push('cssVars: must be an object')
    return undefined
  }
  rejectUnknownKeys(input, ['theme', 'light', 'dark'], 'cssVars.', issues)
  const theme = parseTokens(input.theme, 'cssVars.theme', (key) => themeTokenSet.has(key), issues)
  const light = parseTokens(input.light, 'cssVars.light', (key) => tokenRules.has(key), issues)
  const dark = parseTokens(input.dark, 'cssVars.dark', (key) => tokenRules.has(key), issues)
  return { ...(theme && { theme }), ...(light && { light }), ...(dark && { dark }) }
}

const linkRules: Record<keyof BrandingLinks, TokenRule> = {
  privacyPolicy: { accepts: isHttpUrl, message: httpUrlMessage },
  termsOfService: { accepts: isHttpUrl, message: httpUrlMessage },
  support: {
    accepts: (value) => isHttpUrl(value) || hasProtocol(value, 'mailto:'),
    message: 'must be an http(s) URL or a mailto: address',
  },
}

// Own keys only: `constructor` or `toString` must not find a rule on the prototype.
const isLinkKey = (key: string): key is keyof BrandingLinks => Object.hasOwn(linkRules, key)

// The values become `href`s, so only http(s) (and mailto: for support) pass:
// no `javascript:` or `data:` link can reach the page.
const parseLinks = (input: unknown, issues: string[]): BrandingLinks | undefined => {
  if (input === undefined) {
    return undefined
  }
  if (!isRecord(input)) {
    issues.push('links: must be an object')
    return undefined
  }
  const links: BrandingLinks = {}
  for (const [key, raw] of Object.entries(input)) {
    if (!isLinkKey(key)) {
      issues.push(`links.${key}: unknown key`)
      continue
    }
    const value = typeof raw === 'string' ? raw.trim() : undefined
    if (value === undefined || !linkRules[key].accepts(value)) {
      issues.push(`links.${key}: ${linkRules[key].message}`)
      continue
    }
    links[key] = value
  }
  return links
}

// Names reach email subjects, the tab title and OS dialogs, so no control characters.
const controlCharacterPattern = /\p{Cc}/u

const parseName = (input: unknown, key: string, issues: string[]): string | undefined => {
  if (input === undefined) {
    return undefined
  }
  const trimmed = typeof input === 'string' ? input.trim() : ''
  if (trimmed.length === 0 || trimmed.length > nameMaxLength || controlCharacterPattern.test(trimmed)) {
    issues.push(`${key}: must be a string of 1 to ${nameMaxLength} characters, without control characters`)
    return undefined
  }
  return trimmed
}

const isThemeMode = (value: unknown): value is BrandingThemeMode => brandingThemeModes.some((mode) => mode === value)

const parseThemeMode = (input: unknown, issues: string[]): BrandingThemeMode | undefined => {
  if (input === undefined || isThemeMode(input)) {
    return input
  }
  issues.push(`defaultThemeMode: must be one of ${brandingThemeModes.join(', ')}`)
  return undefined
}

/** The public fields, each validated; a problem is pushed to `issues` and its field dropped. */
const parsePublicFields = (
  input: Record<string, unknown>,
  issues: string[],
): Omit<PublicBranding, 'fonts' | 'logo'> => {
  const appName = parseName(input.appName, 'appName', issues)
  const debugTranscriptRecipient = parseName(input.debugTranscriptRecipient, 'debugTranscriptRecipient', issues)
  const defaultThemeMode = parseThemeMode(input.defaultThemeMode, issues)
  const links = parseLinks(input.links, issues)
  const cssVars = parseCssVars(input.cssVars, issues)
  return {
    ...(appName && { appName }),
    ...(debugTranscriptRecipient && { debugTranscriptRecipient }),
    ...(defaultThemeMode && { defaultThemeMode }),
    ...(links && { links }),
    ...(cssVars && { cssVars }),
  }
}

const parseLogoUrl = (input: Record<string, unknown>, key: 'light' | 'dark', issues: string[]): string | undefined => {
  const value = typeof input[key] === 'string' ? input[key].trim() : undefined
  if (value !== undefined && hasProtocol(value, 'https:')) {
    return value
  }
  issues.push(`logo.${key}: must be an https URL`)
  return undefined
}

const parseLogoUrls = (input: unknown, issues: string[]): BrandingLogoUrls | undefined => {
  if (input === undefined) {
    return undefined
  }
  if (!isRecord(input)) {
    issues.push('logo: must be an object')
    return undefined
  }
  rejectUnknownKeys(input, ['light', 'dark'], 'logo.', issues)
  const light = parseLogoUrl(input, 'light', issues)
  if (input.dark === undefined) {
    return light ? { light } : undefined
  }
  const dark = parseLogoUrl(input, 'dark', issues)
  return light && dark ? { light, dark } : undefined
}

type BrandingParseResult = { ok: true; branding: Branding } | { ok: false; errors: string[] }

/**
 * Validate the operator's `BRANDING`, strictly: an unknown key or a bad value
 * fails the whole value, and every problem is collected so the operator fixes
 * it in one pass. Export keys Thunderbolt ignores are stripped.
 *
 * @param input - Parsed JSON.
 */
export const parseBranding = (input: unknown): BrandingParseResult => {
  if (!isRecord(input)) {
    return { ok: false, errors: ['branding must be a JSON object'] }
  }
  const errors: string[] = []
  rejectUnknownKeys(input, [...publicFields, 'logo'], '', errors)
  const fields = parsePublicFields(input, errors)
  const logo = parseLogoUrls(input.logo, errors)
  return errors.length > 0 ? { ok: false, errors } : { ok: true, branding: { ...fields, ...(logo && { logo }) } }
}

const fontWeightPattern = /^\d{1,3}(?: \d{1,3})?$/
const unicodeRangePattern = /^U\+[0-9A-F?]+(?:-[0-9A-F]+)?(?:, ?U\+[0-9A-F?]+(?:-[0-9A-F]+)?)*$/i
// File names are the first 16 bytes of the SHA-256 of their content, in hex
// (`contentName` in backend/src/branding/download.ts).
const contentHashSource = '[a-f0-9]{32}'
const fontFilePattern = new RegExp(`^${contentHashSource}\\.woff2$`)
const logoFilePattern = new RegExp(`^${contentHashSource}\\.(?:${Object.values(brandingLogoTypes).join('|')})$`)

/**
 * Whether a wire value is a well-formed {@link BrandingFontFace}. Its fields
 * become `FontFace` descriptors and a request path, so each is pattern-checked.
 *
 * @param value - One entry of `branding.fonts` from `/config`.
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

/**
 * Whether a content type is one a branding logo may be.
 *
 * @param type - A bare MIME type.
 */
export const isBrandingLogoType = (type: string): type is BrandingLogoType => Object.hasOwn(brandingLogoTypes, type)

const parseLogoFile = (value: unknown): BrandingLogoFile | undefined =>
  isRecord(value) &&
  typeof value.file === 'string' &&
  logoFilePattern.test(value.file) &&
  typeof value.type === 'string' &&
  isBrandingLogoType(value.type)
    ? { file: value.file, type: value.type }
    : undefined

// A malformed dark logo is dropped on its own; the light one still shows in both modes.
const parseLogoManifest = (input: unknown, issues: string[]): BrandingLogoManifest | undefined => {
  if (input === undefined) {
    return undefined
  }
  const light = isRecord(input) && parseLogoFile(input.light)
  if (!light) {
    issues.push('logo: malformed manifest')
    return undefined
  }
  if (input.dark === undefined) {
    return { light }
  }
  const dark = parseLogoFile(input.dark)
  if (!dark) {
    issues.push('logo.dark: malformed logo dropped')
    return { light }
  }
  return { light, dark }
}

const parseFontFaces = (input: unknown, issues: string[]): BrandingFontFace[] | undefined => {
  if (input === undefined) {
    return undefined
  }
  if (!Array.isArray(input)) {
    issues.push('fonts: must be a list')
    return undefined
  }
  const faces = input.filter(isBrandingFontFace)
  if (faces.length !== input.length) {
    issues.push('fonts: malformed faces dropped')
  }
  return faces.length > 0 ? faces : undefined
}

/**
 * Validate `branding` from `/config`, leniently: unknown keys and bad values
 * are dropped one by one and reported in `issues`, and everything else is
 * kept. A newer backend may add keys or accept values this client doesn't
 * know; strictness here would cost those clients their whole theme. Values
 * still pass the same checks as on the backend, because they become a
 * stylesheet, hrefs and request paths, and the backend a client talks to is a
 * local setting.
 *
 * @param input - `branding` as received.
 */
export const parsePublicBranding = (input: unknown): { branding?: PublicBranding; issues: string[] } => {
  if (!isRecord(input)) {
    return { issues: ['branding must be an object'] }
  }
  const issues: string[] = []
  rejectUnknownKeys(input, [...publicFields, 'fonts', 'logo'], '', issues)
  const fields = parsePublicFields(input, issues)
  const fonts = parseFontFaces(input.fonts, issues)
  const logo = parseLogoManifest(input.logo, issues)
  return { branding: { ...fields, ...(fonts && { fonts }), ...(logo && { logo }) }, issues }
}

/**
 * The radius scale multiplier for a shadcn `radius` length. shadcn's default
 * is 0.625rem, which is our scale 1; px assumes the 16px root.
 *
 * @param radius - A validated non-negative px or rem length.
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

// In oklch chroma and oklab a/b, 100% stands for 0.4.
const okAxis = (arg: string) => (arg.endsWith('%') ? (parseFloat(arg) / 100) * 0.4 : parseFloat(arg))

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

// The sRGB transfer function (IEC 61966-2-1).
const linearToSrgb = (c: number) => (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055)

// OKLab to sRGB, with Björn Ottosson's published matrices.
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

const parseRgb = (color: string): Rgb | undefined => {
  if (color.startsWith('#')) {
    return hexToRgb(color)
  }
  const fn = color.slice(0, color.indexOf('(')).toLowerCase()
  const args = colorArguments(color)
  if (args.length < 3 || args.includes('none')) {
    return undefined
  }
  if (fn === 'rgb' || fn === 'rgba') {
    return args.map((arg) => clamp01(fraction(arg, 255))) as Rgb
  }
  if (fn === 'hsl' || fn === 'hsla') {
    return hslToRgb(args)
  }
  const lightness = fraction(args[0], 1)
  if (fn === 'oklch') {
    const chroma = okAxis(args[1])
    const hue = (parseFloat(args[2]) * Math.PI) / 180
    return oklabToRgb(lightness, chroma * Math.cos(hue), chroma * Math.sin(hue))
  }
  return oklabToRgb(lightness, okAxis(args[1]), okAxis(args[2]))
}

// An argument like `.` passes the color pattern but parses to NaN; such a color can't be evaluated.
const toRgb = (color: string): Rgb | undefined => {
  const rgb = parseRgb(color)
  return rgb?.every(Number.isFinite) ? rgb : undefined
}

// Relative luminance and contrast ratio as WCAG 2 defines them.
const channelLuminance = (c: number): number => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)

const relativeLuminance = ([r, g, b]: Rgb): number =>
  0.2126 * channelLuminance(r) + 0.7152 * channelLuminance(g) + 0.0722 * channelLuminance(b)

const contrastRatio = (a: Rgb, b: Rgb): number => {
  const [lighter, darker] = [relativeLuminance(a), relativeLuminance(b)].sort((x, y) => y - x)
  return (lighter + 0.05) / (darker + 0.05)
}

/**
 * A validated branding color as `#rrggbb`, for surfaces that can't read modern
 * color syntax (email clients); undefined when it can't be evaluated. Alpha is dropped.
 *
 * @param color - A color that passed {@link isCssColor}.
 */
export const toHexColor = (color: string): string | undefined => {
  const rgb = toRgb(color)
  return rgb
    ? `#${rgb
        .map((channel) =>
          Math.round(clamp01(channel) * 255)
            .toString(16)
            .padStart(2, '0'),
        )
        .join('')}`
    : undefined
}

// The default theme's off-white and ink (`--color-brand-foreground` and
// `--color-destructive-foreground` in src/index.css); src/lib/branding.test.ts
// fails when they drift.
const lightInk = '#faf8f5'
const darkInk = '#262120'

/**
 * The theme's off-white or ink, whichever reads better on every given color,
 * or undefined when a color can't be evaluated (an argument of `none`).
 *
 * Takes several colors so text on a gradient is judged against its worst stop.
 *
 * @param backgrounds - Validated colors the text sits on.
 */
export const readableForeground = (...backgrounds: string[]): string | undefined => {
  const rgbs = backgrounds.map(toRgb).filter((rgb) => rgb !== undefined)
  if (rgbs.length !== backgrounds.length) {
    return undefined
  }
  const worstContrast = (ink: string) => Math.min(...rgbs.map((rgb) => contrastRatio(hexToRgb(ink), rgb)))
  return worstContrast(lightInk) >= worstContrast(darkInk) ? lightInk : darkInk
}

/**
 * What fills primary buttons and their text, the same in the app and in
 * emails: `brand`, else shadcn's `primary`. The text is `brand-foreground`
 * (even over a `primary` fill), else `primary-foreground` when the theme has no
 * `brand`, else whichever of the default inks reads better on the fill.
 *
 * @param tokens - One mode's validated tokens.
 * @returns Undefined when the theme sets neither color.
 */
export const resolveBrandFill = (
  tokens: BrandingModeTokens,
): { fill: string; gradientStart: string; foreground?: string } | undefined => {
  const fill = tokens.brand ?? tokens.primary
  if (!fill) {
    return undefined
  }
  // The gradient runs from its start color to `fill`; without one, both stops are `fill`.
  const gradientStart = tokens['brand-gradient-start'] ?? fill
  const namedForeground = tokens['brand-foreground'] ?? (tokens.brand ? undefined : tokens['primary-foreground'])
  return { fill, gradientStart, foreground: namedForeground ?? readableForeground(gradientStart, fill) }
}
