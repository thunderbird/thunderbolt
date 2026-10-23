/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useConfigStore } from '@/api/config-store'
import { brandingColorTokens, resolveBrandFill, type BrandingModeTokens, type PublicBranding } from '@shared/branding'
import { renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, mock, spyOn } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { applyBranding, buildBrandingCss, installBranding } from './branding'
import { selectAppName, selectBranding, useBrandingLinks, useDebugTranscriptRecipient } from './branding-selectors'

/** The declarations of one rule, as a map, so assertions don't depend on order. */
const declarationsOf = (css: string, selector: string): Record<string, string> => {
  const line = css.split('\n').find((rule) => rule.startsWith(`${selector} {`))
  if (!line) {
    return {}
  }
  const body = line.slice(line.indexOf('{') + 1, line.lastIndexOf('}'))
  return Object.fromEntries(
    body
      .split(/;\s*(?=--|letter-spacing)/)
      .map((declaration) => declaration.replace(/;\s*$/, '').trim())
      .filter(Boolean)
      .map((declaration) => {
        const colon = declaration.indexOf(':')
        return [declaration.slice(0, colon).trim(), declaration.slice(colon + 1).trim()]
      }),
  )
}

const light = (tokens: BrandingModeTokens) =>
  declarationsOf(buildBrandingCss({ cssVars: { light: tokens } }), 'html:not(.dark)')

describe('buildBrandingCss', () => {
  it('is empty without branding or overrides', () => {
    expect(buildBrandingCss(undefined)).toBe('')
    expect(buildBrandingCss({ appName: 'Acme' })).toBe('')
  })

  it('renders a lone brand color as a solid: both gradient stops are the same color', () => {
    const vars = light({ brand: '#2563eb' })
    expect(vars['--color-brand']).toBe('#2563eb')
    expect(vars['--color-brand-2']).toBe('#2563eb')
    expect(vars['--color-brand-muted']).toBe('color-mix(in oklch, #2563eb 90%, gray)')
    expect(vars['--color-brand-foreground']).toBe('#faf8f5')
  })

  it('renders a gradient when brand-gradient-start is set, starting from it', () => {
    const vars = light({ brand: '#7c3aed', 'brand-gradient-start': '#2563eb' })
    expect(vars['--color-brand']).toBe('#7c3aed')
    expect(vars['--color-brand-2']).toBe('#2563eb')
    expect(vars['--color-brand-2-muted']).toBe('color-mix(in oklch, #2563eb 90%, gray)')
  })

  it("fills brand from a shadcn theme's primary, with its foreground", () => {
    const vars = light({ primary: 'oklch(0.65 0.24 27)', 'primary-foreground': 'oklch(1 0 0)' })
    expect(vars['--color-brand']).toBe('oklch(0.65 0.24 27)')
    expect(vars['--color-brand-2']).toBe('oklch(0.65 0.24 27)')
    expect(vars['--color-brand-foreground']).toBe('oklch(1 0 0)')
    expect(vars['--color-sidebar-primary']).toBe('oklch(0.65 0.24 27)')
    expect(vars['--color-sidebar-primary-foreground']).toBe('oklch(1 0 0)')
  })

  it('keeps an explicit brand separate from primary', () => {
    const vars = light({ primary: '#111111', brand: '#ff5c00' })
    expect(vars['--color-primary']).toBe('#111111')
    expect(vars['--color-brand']).toBe('#ff5c00')
    expect(vars['--color-primary-foreground']).toBe('#faf8f5')
  })

  it('derives surfaces from background and foreground, and explicit tokens win', () => {
    const vars = light({ background: '#f1f5f9', card: '#ffffff' })
    expect(vars['--color-background']).toBe('#f1f5f9')
    expect(vars['--color-card']).toBe('#ffffff')
    expect(vars['--color-popover']).toBe('color-mix(in oklch, var(--color-background), #fff 45%)')
    expect(vars['--color-border']).toBe('color-mix(in oklch, var(--color-background), var(--color-foreground) 13%)')
    expect(vars['--color-muted-foreground']).toBe(
      'color-mix(in oklch, var(--color-foreground), var(--color-background) 45%)',
    )
    expect(vars['--color-sidebar-foreground']).toBe('var(--color-foreground)')
  })

  it('lifts dark-mode surfaces toward the foreground, not white', () => {
    const vars = declarationsOf(buildBrandingCss({ cssVars: { dark: { background: '#0f172a' } } }), 'html.dark')
    expect(vars['--color-card']).toBe('color-mix(in oklch, var(--color-background), var(--color-foreground) 7%)')
  })

  it("applies a theme's dark input at shadcn's 30% field fill, so white text stays readable", () => {
    const css = buildBrandingCss({ cssVars: { light: { input: '#000000' }, dark: { input: 'oklch(1 0 0)' } } })
    expect(declarationsOf(css, 'html.dark')['--color-input']).toBe('color-mix(in oklab, oklch(1 0 0) 30%, transparent)')
    // Light mode keeps shadcn's meaning: a border and switch-track color.
    expect(declarationsOf(css, 'html:not(.dark)')['--color-input']).toBe('#000000')
  })

  it('derives a translucent dark input fill, like the default', () => {
    const vars = declarationsOf(buildBrandingCss({ cssVars: { dark: { background: '#0f172a' } } }), 'html.dark')
    expect(vars['--color-input']).toBe('color-mix(in oklab, var(--color-foreground) 7%, transparent)')
  })

  it('does not derive surfaces when only accents change', () => {
    expect(light({ brand: '#2563eb' })).not.toHaveProperty('--color-card')
  })

  it('maps explicit shadcn tokens onto our variables', () => {
    const vars = light({ 'sidebar-accent': '#ffe066', 'chart-3': '#00ff00', ring: '#123456' })
    expect(vars['--color-sidebar-accent']).toBe('#ffe066')
    expect(vars['--color-chart-3']).toBe('#00ff00')
    expect(vars['--color-ring']).toBe('#123456')
  })

  it('generates the shadow scale from the shadow parameters (neo-brutalism)', () => {
    const vars = light({
      'shadow-color': 'hsl(0 0% 0%)',
      'shadow-opacity': '1',
      'shadow-blur': '0px',
      'shadow-spread': '0px',
      'shadow-offset-x': '4px',
      'shadow-offset-y': '4px',
    })
    const solid = 'color-mix(in srgb, hsl(0 0% 0%) 100%, transparent)'
    expect(vars['--theme-shadow-xs']).toBe('4px 4px 0px 0px color-mix(in srgb, hsl(0 0% 0%) 50%, transparent)')
    expect(vars['--theme-shadow-lg']).toBe(`4px 4px 0px 0px ${solid}, 4px 4px 6px calc(0px - 1px) ${solid}`)
    expect(vars['--theme-shadow-2xl']).toBe(`4px 4px 0px 0px ${solid}`)
    expect(vars['--theme-shadow-glow']).toBe(`4px 4px 0px ${solid}`)
  })

  it('fills missing shadow parameters with defaults', () => {
    const vars = light({ 'shadow-opacity': '0.2' })
    expect(vars['--theme-shadow-xs']).toBe('0px 1px 3px 0px color-mix(in srgb, hsl(0 0% 0%) 10%, transparent)')
  })

  it('sets each font slot, followed by the system and CJK fallbacks', () => {
    const vars = declarationsOf(
      buildBrandingCss({
        cssVars: {
          theme: { 'font-sans': '"DM Sans", sans-serif', 'font-heading': 'Space Grotesk', 'font-mono': 'Space Mono' },
        },
      }),
      'html:root',
    )
    expect(vars['--font-sans']).toStartWith('"DM Sans", ui-sans-serif, system-ui, "Hiragino Sans"')
    expect(vars['--font-sans']).toContain('"Noto Sans JP", sans-serif')
    expect(vars['--font-heading']).toStartWith('"Space Grotesk", ui-sans-serif')
    expect(vars['--font-mono']).toBe(
      '"Space Mono", ui-monospace, "SFMono-Regular", "Menlo", "Monaco", "Consolas", "Liberation Mono", "Courier New", monospace',
    )
    expect(vars).not.toHaveProperty('--font-serif')
  })

  it('keeps a listed system font once and leaves generics unquoted', () => {
    const vars = declarationsOf(
      buildBrandingCss({ cssVars: { theme: { 'font-serif': 'Georgia, serif' } } }),
      'html:root',
    )
    expect(vars['--font-serif']).toBe(
      '"Georgia", ui-serif, "Cambria", "Times New Roman", "Times", "Hiragino Mincho ProN", "Yu Mincho", "Noto Serif CJK JP", serif',
    )
  })

  it('sets radius and letter spacing for every mode, preferring the theme block', () => {
    const css = buildBrandingCss({
      cssVars: { theme: { radius: '0px' }, light: { radius: '1rem', 'letter-spacing': '-0.01em' } },
    })
    expect(declarationsOf(css, 'html:root')).toEqual({ '--radius-scale': '0', 'letter-spacing': '-0.01em' })
  })
})

// Branding can only override what the theme defines, and mirrors its default inks.
describe('parity with src/index.css', () => {
  const indexCss = readFileSync(join(import.meta.dir, '..', 'index.css'), 'utf8')
  const definedVars = new Set([...indexCss.matchAll(/^\s*(--color-[\w-]+):/gm)].map(([, name]) => name))
  // Everything before the first `.dark` block is the light theme.
  const lightCss = indexCss.slice(0, indexCss.indexOf('\n.dark {'))
  const lightValue = (name: string) => lightCss.match(new RegExp(`^\\s*${name}:\\s*([^;]+);`, 'm'))?.[1]
  const fontFamilies = (list: string) => list.split(',').map((family) => family.trim().replace(/^['"]|['"]$/g, ''))

  it.each([...brandingColorTokens])('maps the %s token onto a color the theme defines', (token) => {
    const declared = Object.keys(light({ [token]: '#123456' }))
    expect(declared.length).toBeGreaterThan(0)
    expect(declared.filter((name) => name.startsWith('--color-') && !definedVars.has(name))).toEqual([])
  })

  it('picks the default theme inks for text on a branded fill', () => {
    expect(resolveBrandFill({ brand: '#000000' })?.foreground).toBe(lightValue('--color-brand-foreground'))
    expect(resolveBrandFill({ brand: '#ffffff' })?.foreground).toBe(lightValue('--color-destructive-foreground'))
  })

  it('overrides every shadow size the theme defines, and only those', () => {
    const themeShadows = new Set([...indexCss.matchAll(/^\s*(--theme-shadow-[\w-]+):/gm)].map(([, name]) => name))
    const branded = Object.keys(light({ 'shadow-color': '#000000' })).filter((name) =>
      name.startsWith('--theme-shadow-'),
    )
    expect(new Set(branded)).toEqual(themeShadows)
  })

  it("follows operator fonts with the default heading font's system and CJK chain", () => {
    const headingChain = fontFamilies(lightValue('--font-heading') ?? '').slice(1)
    const fontSans = declarationsOf(buildBrandingCss({ cssVars: { theme: { 'font-sans': 'Inter' } } }), 'html:root')[
      '--font-sans'
    ]
    expect(headingChain.length).toBeGreaterThan(0)
    expect(fontFamilies(fontSans).slice(1, 1 + headingChain.length)).toEqual(headingChain)
  })
})

describe('selectBranding', () => {
  afterEach(() => {
    mock.restore()
  })

  it('returns valid branding', () => {
    const branding: PublicBranding = { appName: 'Acme', cssVars: { dark: { brand: '#fff' } } }
    expect(selectBranding({ branding })).toEqual(branding)
  })

  it('drops only what fails validation, so nothing unchecked reaches the stylesheet', () => {
    const warn = spyOn(console, 'warn').mockImplementation(() => {})
    const tampered = { appName: 'Acme', favicon: 'x', cssVars: { light: { brand: 'red; } body { display: none' } } }
    expect(selectBranding({ branding: tampered })).toEqual({ appName: 'Acme', cssVars: { light: {} } })
    expect(warn).toHaveBeenCalled()
  })

  it('ignores branding that is not an object, rather than crashing boot, and warns once per value', () => {
    const warn = spyOn(console, 'warn').mockImplementation(() => {})
    for (const branding of ['x', 1, true, null]) {
      expect(selectBranding({ branding })).toBeUndefined()
    }
    selectBranding({ branding: null })
    expect(warn).toHaveBeenCalledTimes(4)
  })

  it('is undefined when absent', () => {
    expect(selectBranding({})).toBeUndefined()
  })
})

describe('useBrandingLinks', () => {
  afterEach(() => {
    useConfigStore.setState({ config: {} })
  })

  it("defaults to Thunderbolt's own policies and support", () => {
    const { result } = renderHook(() => useBrandingLinks())
    expect(result.current).toEqual({
      privacyPolicy: 'https://www.thunderbird.net/en-US/privacy/',
      termsOfService: 'https://www.mozilla.org/en-US/about/legal/terms/mozilla/',
      support: 'mailto:support@thunderbird.net',
    })
  })

  it("prefers the operator's links, falling back per link", () => {
    useConfigStore.setState({ config: { branding: { links: { privacyPolicy: 'https://acme.test/privacy' } } } })
    const { result } = renderHook(() => useBrandingLinks())
    expect(result.current.privacyPolicy).toBe('https://acme.test/privacy')
    expect(result.current.termsOfService).toBe('https://www.mozilla.org/en-US/about/legal/terms/mozilla/')
  })
})

describe('selectAppName', () => {
  it('defaults to Thunderbolt', () => {
    expect(selectAppName({})).toBe('Thunderbolt')
    expect(selectAppName({ branding: { appName: 'Acme AI' } })).toBe('Acme AI')
  })
})

describe('applyBranding', () => {
  afterEach(() => {
    applyBranding(undefined)
    useConfigStore.setState({ config: {} })
  })

  it('writes the stylesheet and the title, and restores both on reset', () => {
    applyBranding({ appName: 'Acme AI', cssVars: { theme: { radius: '1.25rem' } } })
    expect(document.getElementById('branding')?.textContent).toBe('html:root { --radius-scale: 2; }')
    expect(document.title).toBe('Acme AI')

    applyBranding(undefined)
    expect(document.getElementById('branding')?.textContent).toBe('')
    expect(document.title).toBe('Thunderbolt')
    expect(document.querySelectorAll('#branding')).toHaveLength(1)
  })
})

describe('useDebugTranscriptRecipient', () => {
  afterEach(() => {
    useConfigStore.setState({ config: {} })
  })

  it("names the operator's recipient, else Thunderbolt even under another app name", () => {
    useConfigStore.setState({ config: { branding: { appName: 'Acme AI' } } })
    expect(renderHook(() => useDebugTranscriptRecipient()).result.current).toBe('Thunderbolt')

    useConfigStore.setState({ config: { branding: { debugTranscriptRecipient: 'Acme Support' } } })
    expect(renderHook(() => useDebugTranscriptRecipient()).result.current).toBe('Acme Support')
  })
})

describe('installBranding', () => {
  afterEach(() => {
    useConfigStore.setState({ config: {} })
    applyBranding(undefined)
  })

  it('applies the cached branding, re-applies on a new config, and stops when unsubscribed', () => {
    useConfigStore.setState({ config: { branding: { appName: 'Cached' } } })
    const unsubscribe = installBranding()
    expect(document.title).toBe('Cached')

    useConfigStore.setState({ config: { branding: { appName: 'Fresh' } } })
    expect(document.title).toBe('Fresh')

    unsubscribe()
    useConfigStore.setState({ config: { branding: { appName: 'Ignored' } } })
    expect(document.title).toBe('Fresh')
  })
})
