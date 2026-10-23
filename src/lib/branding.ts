/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useConfigStore, type AppConfig } from '@/api/config-store'
import { createClient } from '@/lib/http'
import { getLocalSetting } from '@/stores/local-settings-store'
import {
  brandingColorTokens,
  brandingFontFamilies,
  defaultAppName,
  isGenericFontFamily,
  type BrandingFontToken,
  radiusScaleFor,
  readableForeground,
  type Branding,
  type BrandingColorToken,
  type BrandingModeTokens,
} from '@shared/branding'
import { syncBrandingFonts } from './branding-fonts'
import { syncBrandingLogo } from './branding-logo'
import { selectBranding } from './branding-selectors'
import { syncDocumentBackground } from './document-background'

type Mode = 'light' | 'dark'

const cssVarFor = (token: BrandingColorToken) => (token === 'brand-secondary' ? '--color-brand-2' : `--color-${token}`)

const mix = (from: string, to: string, percent: number) => `color-mix(in oklch, ${from}, ${to} ${percent}%)`
const bg = 'var(--color-background)'
const fg = 'var(--color-foreground)'

/**
 * Surface tokens derived from `background` and `foreground` when a mode sets
 * either. Blending toward the foreground darkens in light mode and lightens in
 * dark mode, so one formula serves both; cards lift toward white in light mode
 * and toward the foreground in dark mode, as the default palette does.
 * Approximates the hand-tuned defaults when fed the default pair.
 */
const derivedSurfaces = (mode: Mode): Partial<Record<BrandingColorToken, string>> => {
  const lifted = mode === 'light' ? mix(bg, '#fff', 45) : mix(bg, fg, 7)
  return {
    card: lifted,
    popover: lifted,
    sidebar: mode === 'light' ? mix(bg, '#fff', 70) : lifted,
    secondary: mix(bg, fg, 5),
    muted: mix(bg, fg, 5),
    accent: mix(bg, fg, 7),
    'sidebar-accent': mix(bg, fg, 7),
    border: mix(bg, fg, 13),
    // Dark `input` is a field fill (see darkFieldFill), translucent like the default.
    input: mode === 'light' ? mix(bg, fg, 13) : `color-mix(in oklab, ${fg} 7%, transparent)`,
    'sidebar-border': mix(bg, fg, 13),
    'border-strong': mix(bg, fg, 30),
    'muted-foreground': mix(fg, bg, 45),
    'card-foreground': fg,
    'popover-foreground': fg,
    'secondary-foreground': fg,
    'accent-foreground': fg,
    'sidebar-foreground': fg,
    'sidebar-accent-foreground': fg,
  }
}

/** Desaturates a stop at roughly equal lightness, for the quieter "on" states (Switch track). */
const muted = (color: string) => `color-mix(in oklch, ${color} 90%, gray)`

/**
 * Tokens Thunderbolt adds on top of shadcn's, filled from what a shadcn theme
 * does carry. shadcn's `primary` is the action color — it fills buttons — while
 * ours fills tooltips and selected states and the brand gradient fills
 * buttons, so a theme without `brand` gets its `primary` there too.
 */
const brandTokens = (tokens: BrandingModeTokens): Partial<Record<BrandingColorToken, string>> => {
  const brand = tokens.brand ?? tokens.primary
  // The gradient runs brand-2 → brand. With no secondary both stops are the
  // same color, which renders solid everywhere the gradient is used —
  // including the bg-clip-text call sites, which `--gradient-brand: none`
  // would leave invisible.
  const gradientStart = tokens['brand-secondary'] ?? brand
  if (!brand || !gradientStart) {
    return {}
  }
  const foreground =
    tokens['brand-foreground'] ??
    (tokens.brand ? undefined : tokens['primary-foreground']) ??
    readableForeground(gradientStart, brand) ??
    undefined
  return { brand, 'brand-secondary': gradientStart, ...(foreground && { 'brand-foreground': foreground }) }
}

const primaryTokens = (tokens: BrandingModeTokens): Partial<Record<BrandingColorToken, string>> => {
  if (!tokens.primary) {
    return {}
  }
  const foreground = tokens['primary-foreground'] ?? readableForeground(tokens.primary) ?? undefined
  return {
    ...(foreground && { 'primary-foreground': foreground, 'sidebar-primary-foreground': foreground }),
    'sidebar-primary': tokens.primary,
  }
}

const shadowDefaults = {
  color: 'hsl(0 0% 0%)',
  opacity: 0.1,
  blur: '3px',
  spread: '0px',
  x: '0px',
  y: '1px',
}

/**
 * The full shadow scale from tweakcn's six parameters, using tweakcn's own
 * generator so an exported theme renders as it did in the editor. The glow
 * tokens get a single spread-less shadow, which `filter: drop-shadow()` (the
 * detail panel) also accepts.
 */
const shadowDeclarations = (tokens: BrandingModeTokens): string[] => {
  const hasShadow = Object.keys(tokens).some((key) => key.startsWith('shadow-'))
  if (!hasShadow) {
    return []
  }
  const color = tokens['shadow-color'] ?? shadowDefaults.color
  const opacity = tokens['shadow-opacity'] !== undefined ? Number(tokens['shadow-opacity']) : shadowDefaults.opacity
  const blur = tokens['shadow-blur'] ?? shadowDefaults.blur
  const spread = tokens['shadow-spread'] ?? shadowDefaults.spread
  const x = tokens['shadow-offset-x'] ?? shadowDefaults.x
  const y = tokens['shadow-offset-y'] ?? shadowDefaults.y

  const tint = (factor: number) =>
    `color-mix(in srgb, ${color} ${Math.min(100, Math.round(opacity * factor * 10000) / 100)}%, transparent)`
  const base = (factor: number) => `${x} ${y} ${blur} ${spread} ${tint(factor)}`
  const layered = (offsetY: string, layerBlur: string) =>
    `${base(1)}, ${x} ${offsetY} ${layerBlur} calc(${spread} - 1px) ${tint(1)}`
  const glow = `${x} ${y} ${blur} ${tint(1)}`

  const scale: Record<string, string> = {
    '2xs': base(0.5),
    xs: base(0.5),
    sm: layered('1px', '2px'),
    md: layered('2px', '4px'),
    lg: layered('4px', '6px'),
    xl: layered('8px', '10px'),
    '2xl': base(2.5),
    glow,
    'glow-sm': glow,
    'glow-strong': glow,
  }
  return Object.entries(scale).map(([size, value]) => `--theme-shadow-${size}: ${value};`)
}

/**
 * In shadcn, `input` is an opaque field-border color and dark fields fill with
 * it at 30% (`dark:bg-input/30`). Our fields fill with `input` itself in dark
 * mode (`dark:bg-input`, a translucent white by default), so a theme's dark
 * `input` is applied at the 30% shadcn renders — at full strength a white
 * `input` turns every dark field white under white text.
 */
const darkFieldFill = (input: string) => `color-mix(in oklab, ${input} 30%, transparent)`

const modeDeclarations = (mode: Mode, tokens: BrandingModeTokens): string[] => {
  const derives = tokens.background !== undefined || tokens.foreground !== undefined
  const colors: Partial<Record<BrandingColorToken, string>> = {
    ...(derives && derivedSurfaces(mode)),
    ...primaryTokens(tokens),
    ...brandTokens(tokens),
    ...Object.fromEntries(brandingColorTokens.flatMap((token) => (tokens[token] ? [[token, tokens[token]]] : []))),
    ...(mode === 'dark' && tokens.input && { input: darkFieldFill(tokens.input) }),
  }
  const colorDeclarations = Object.entries(colors).map(
    ([token, value]) => `${cssVarFor(token as BrandingColorToken)}: ${value};`,
  )
  const mutedBrand = [
    colors.brand && `--color-brand-muted: ${muted(colors.brand)};`,
    colors['brand-secondary'] && `--color-brand-2-muted: ${muted(colors['brand-secondary'])};`,
  ].filter((declaration) => typeof declaration === 'string')

  return [...colorDeclarations, ...mutedBrand, ...shadowDeclarations(tokens)]
}

const sansFallback = [
  'ui-sans-serif',
  'system-ui',
  'Hiragino Sans',
  'Yu Gothic',
  'Noto Sans CJK JP',
  'Noto Sans JP',
  'sans-serif',
  'Apple Color Emoji',
  'Segoe UI Emoji',
  'Segoe UI Symbol',
  'Noto Color Emoji',
]

/**
 * What every operator font list is followed by. Brand fonts are mostly
 * Latin-only, so the system and CJK fonts (the same chain the default heading
 * font uses) keep Japanese and other scripts rendering; operator-written
 * generics are dropped in favor of these, which end in the right generic.
 */
const fontFallbacks: Record<BrandingFontToken, string[]> = {
  'font-sans': sansFallback,
  'font-heading': sansFallback,
  'font-serif': [
    'ui-serif',
    'Georgia',
    'Cambria',
    'Times New Roman',
    'Times',
    'Hiragino Mincho ProN',
    'Yu Mincho',
    'Noto Serif CJK JP',
    'serif',
  ],
  'font-mono': [
    'ui-monospace',
    'SFMono-Regular',
    'Menlo',
    'Monaco',
    'Consolas',
    'Liberation Mono',
    'Courier New',
    'monospace',
  ],
}

// Generic keywords must stay bare: a quoted "sans-serif" names a font called that.
const fontName = (name: string) => (isGenericFontFamily(name) ? name : `"${name}"`)

const fontDeclarations = (branding: Branding | undefined): string[] =>
  Object.entries(brandingFontFamilies(branding)).map(([slot, names]) => {
    const fallback = fontFallbacks[slot as BrandingFontToken]
    const chosen = names.filter((name) => !isGenericFontFamily(name))
    const list = [...new Set([...chosen, ...fallback])]
    return `--${slot}: ${list.map(fontName).join(', ')};`
  })

const rule = (selector: string, declarations: string[]): string =>
  declarations.length > 0 ? `${selector} { ${declarations.join(' ')} }` : ''

/**
 * The stylesheet that overrides index.css tokens with the operator's branding.
 *
 * `html:not(.dark)` and `html.dark` (specificity 0,1,1) beat the `:root` theme
 * tokens and the `.dark` block (0,1,0) whatever the load order, and never match
 * the same document state, so light overrides cannot leak into dark mode.
 * Precedence per mode: explicit tokens, then what Thunderbolt fills from them
 * (brand from primary, foregrounds by contrast), then surfaces derived from
 * background/foreground, then the bundled defaults.
 *
 * @param branding - Validated branding, or undefined for none.
 * @returns CSS text; empty when nothing is overridden.
 */
export const buildBrandingCss = (branding: Branding | undefined): string => {
  const { theme = {}, light = {}, dark = {} } = branding?.cssVars ?? {}
  // Mode-independent; tweakcn repeats them in each mode, so light stands in for theme.
  const radius = theme.radius ?? light.radius ?? dark.radius
  const letterSpacing = theme['letter-spacing'] ?? light['letter-spacing'] ?? dark['letter-spacing']
  const global = [
    radius !== undefined && `--radius-scale: ${radiusScaleFor(radius)};`,
    letterSpacing !== undefined && `letter-spacing: ${letterSpacing};`,
    ...fontDeclarations(branding),
  ].filter((declaration) => typeof declaration === 'string')

  return [
    rule('html:root', global),
    rule('html:not(.dark)', modeDeclarations('light', light)),
    rule('html.dark', modeDeclarations('dark', dark)),
  ]
    .filter(Boolean)
    .join('\n')
}

const styleElementId = 'branding'

/**
 * Apply branding to the document: the override stylesheet, the tab title, and
 * the html background and `theme-color` meta that mirror `--color-background`.
 *
 * @param branding - Validated branding, or undefined to restore the defaults.
 */
export const applyBranding = (branding: Branding | undefined) => {
  const existing = document.getElementById(styleElementId)
  const style =
    existing ?? document.head.appendChild(Object.assign(document.createElement('style'), { id: styleElementId }))
  style.textContent = buildBrandingCss(branding)
  document.title = branding?.appName ?? defaultAppName
  syncDocumentBackground()
}

/**
 * Apply the cached branding now and re-apply whenever `/config` replaces it.
 * Call once before the first render; the config store rehydrates from
 * localStorage synchronously, so returning visits paint branded.
 */
export const installBranding = () => {
  const backend = () => createClient({ prefixUrl: getLocalSetting('cloudUrl') })
  const loadFonts = (config: AppConfig) =>
    // Fonts are cosmetic: a failed download leaves the fallback fonts showing and retries on the next /config.
    syncBrandingFonts(config.brandingFonts, backend()).catch((error: unknown) =>
      console.warn('[branding] font download failed:', error),
    )
  const loadLogo = (config: AppConfig) => syncBrandingLogo(config.brandingLogo, backend())

  const { config } = useConfigStore.getState()
  applyBranding(selectBranding(config))
  void loadFonts(config)
  void loadLogo(config)
  useConfigStore.subscribe((state, previous) => {
    if (state.config.branding !== previous.config.branding) {
      applyBranding(selectBranding(state.config))
    }
    if (state.config.brandingFonts !== previous.config.brandingFonts) {
      void loadFonts(state.config)
    }
    if (state.config.brandingLogo !== previous.config.brandingLogo) {
      void loadLogo(state.config)
    }
  })
}
