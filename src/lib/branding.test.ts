/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useConfigStore, type AppConfig } from '@/api/config-store'
import type { Branding } from '@shared/branding'
import { renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'bun:test'
import { applyBranding, buildBrandingCss } from './branding'
import { selectAppName, selectBranding, useBrandingLinks } from './branding-selectors'

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

const light = (tokens: NonNullable<Branding['cssVars']>['light']) =>
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

  it('renders a gradient when brand-secondary is set, starting from it', () => {
    const vars = light({ brand: '#7c3aed', 'brand-secondary': '#2563eb' })
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

describe('selectBranding', () => {
  it('returns valid branding', () => {
    const branding: Branding = { appName: 'Acme', cssVars: { dark: { brand: '#fff' } } }
    expect(selectBranding({ branding })).toEqual(branding)
  })

  it('drops branding that fails validation, so nothing unchecked reaches the stylesheet', () => {
    const tampered = { cssVars: { light: { brand: 'red; } body { display: none' } } } as AppConfig['branding']
    expect(selectBranding({ branding: tampered })).toBeUndefined()
    expect(selectBranding({ branding: { favicon: 'x' } as unknown as AppConfig['branding'] })).toBeUndefined()
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
