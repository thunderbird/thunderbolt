/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'bun:test'
import {
  brandingFontFamilies,
  isBrandingFontFace,
  isBrandingLogoManifest,
  isCssColor,
  isCssLength,
  parseBranding,
  parseFontFamilies,
  radiusScaleFor,
  readableForeground,
  toHexColor,
} from './branding'

// Abridged from tweakcn's "neo-brutalism" registry item (cssVars), keeping
// every kind of key an export carries.
const neoBrutalismCssVars = {
  theme: {
    'font-sans': 'DM Sans, sans-serif',
    'font-mono': 'Space Mono, monospace',
    radius: '0px',
    'tracking-tight': 'calc(var(--tracking-normal) - 0.025em)',
  },
  light: {
    background: 'oklch(1.0000 0 0)',
    foreground: 'oklch(0 0 0)',
    card: 'oklch(1.0000 0 0)',
    primary: 'oklch(0.6489 0.2370 26.9728)',
    'primary-foreground': 'oklch(1.0000 0 0)',
    border: 'oklch(0 0 0)',
    'chart-1': 'oklch(0.6489 0.2370 26.9728)',
    radius: '0px',
    'sidebar-border': 'oklch(0 0 0)',
    'font-sans': 'DM Sans, sans-serif',
    'shadow-color': 'hsl(0 0% 0%)',
    'shadow-opacity': '1',
    'shadow-blur': '0px',
    'shadow-spread': '0px',
    'shadow-offset-x': '4px',
    'shadow-offset-y': '4px',
    'letter-spacing': '0em',
    spacing: '0.25rem',
    'shadow-lg': '4px 4px 0px 0px hsl(0 0% 0% / 1.00), 4px 4px 6px -1px hsl(0 0% 0% / 1.00)',
    'tracking-normal': '0em',
  },
  dark: {
    background: 'oklch(0 0 0)',
    foreground: 'oklch(1.0000 0 0)',
  },
}

describe('isCssColor', () => {
  it('accepts hex and numeric color functions', () => {
    for (const value of [
      '#fff',
      '#ffff',
      '#2563EB',
      '#2563eb80',
      'rgb(37 99 235)',
      'rgba(37, 99, 235, 0.5)',
      'hsl(0 0% 0%)',
      'hsl(210deg 40% 50% / 0.5)',
      'oklch(0.6489 0.2370 26.9728)',
      'oklch(65% 0.2 none)',
      'oklab(0.5 -0.1 0.1)',
    ]) {
      expect(isCssColor(value)).toBe(true)
    }
  })

  it('rejects anything that could escape a declaration', () => {
    for (const value of [
      'red',
      'fff',
      '#ggg',
      'oklch(0.5 0.1 20); } body { display: none',
      'rgb(0 0 0)}',
      'var(--x)',
      'url(x)',
      'color-mix(in oklch, red, blue)',
      '',
    ]) {
      expect(isCssColor(value)).toBe(false)
    }
  })
})

describe('isCssLength', () => {
  it('accepts px, rem, em and bare numbers, negative allowed', () => {
    for (const value of ['0', '0px', '4px', '0.625rem', '-0.025em', '.5rem']) {
      expect(isCssLength(value)).toBe(true)
    }
    for (const value of ['4', '4pt', 'calc(1px)', '4px;', '']) {
      expect(isCssLength(value)).toBe(value === '4')
    }
  })
})

describe('parseBranding', () => {
  it('accepts a pasted tweakcn export and strips the keys we do not apply', () => {
    const result = parseBranding({ appName: ' Acme ', cssVars: neoBrutalismCssVars })
    if (!result.ok) {
      throw new Error(result.errors.join('\n'))
    }
    expect(result.branding.appName).toBe('Acme')
    expect(result.branding.cssVars?.theme).toEqual({
      'font-sans': 'DM Sans, sans-serif',
      'font-mono': 'Space Mono, monospace',
      radius: '0px',
    })
    const light = result.branding.cssVars?.light ?? {}
    expect(light.primary).toBe('oklch(0.6489 0.2370 26.9728)')
    expect(light['shadow-offset-x']).toBe('4px')
    expect(light['font-sans']).toBe('DM Sans, sans-serif')
    expect(light).not.toHaveProperty('tracking-normal')
    expect(light).not.toHaveProperty('shadow-lg')
    expect(light).not.toHaveProperty('spacing')
  })

  it('accepts numeric shadow opacity', () => {
    expect(parseBranding({ cssVars: { light: { 'shadow-opacity': 0.2 } } }).ok).toBe(true)
  })

  it('collects every problem', () => {
    const result = parseBranding({
      favicon: 'x',
      appName: '',
      defaultThemeMode: 'sepia',
      cssVars: {
        theme: { background: '#fff' },
        light: { card: 'red', 'shadow-opacity': '2', radius: '-1px', cards: '#fff' },
        midnight: {},
      },
    })
    expect(result.ok).toBe(false)
    if (result.ok) {
      return
    }
    expect(result.errors).toEqual(
      expect.arrayContaining([
        'favicon: unknown key',
        'appName: must be a string of 1 to 60 characters',
        'defaultThemeMode: must be one of light, dark, system',
        'cssVars.midnight: unknown key',
        'cssVars.theme.background: unknown token',
        'cssVars.light.card: must be a hex, rgb(), hsl(), oklch() or oklab() color',
        'cssVars.light.shadow-opacity: must be a number from 0 to 1',
        'cssVars.light.radius: must be a non-negative px or rem length',
        'cssVars.light.cards: unknown token',
      ]),
    )
  })

  it('rejects non-objects', () => {
    expect(parseBranding('x').ok).toBe(false)
    expect(parseBranding([]).ok).toBe(false)
    expect(parseBranding({ cssVars: { light: [] } }).ok).toBe(false)
  })

  it('accepts operator links, trimmed', () => {
    const result = parseBranding({
      links: {
        privacyPolicy: ' https://acme.com/privacy ',
        termsOfService: 'https://acme.com/terms',
        support: 'mailto:help@acme.com',
      },
    })
    expect(result).toEqual({
      ok: true,
      branding: {
        links: {
          privacyPolicy: 'https://acme.com/privacy',
          termsOfService: 'https://acme.com/terms',
          support: 'mailto:help@acme.com',
        },
      },
    })
    expect(parseBranding({ links: { support: 'https://acme.com/help' } }).ok).toBe(true)
  })

  it('rejects links that could run script or are not web addresses', () => {
    const result = parseBranding({
      links: {
        privacyPolicy: 'javascript:alert(1)',
        termsOfService: 'mailto:legal@acme.com',
        support: 'data:text/html,hi',
        blog: 'https://acme.com/blog',
      },
    })
    expect(result.ok).toBe(false)
    if (result.ok) {
      return
    }
    expect(result.errors).toEqual([
      'links.privacyPolicy: must be an http(s) URL',
      'links.termsOfService: must be an http(s) URL',
      'links.support: must be an http(s) URL or a mailto: address',
      'links.blog: unknown key',
    ])
  })
})

describe('logo', () => {
  it('accepts https URLs for light and an optional dark', () => {
    expect(parseBranding({ logo: { light: 'https://acme.com/mark.svg' } })).toEqual({
      ok: true,
      branding: { logo: { light: 'https://acme.com/mark.svg' } },
    })
    expect(parseBranding({ logo: { light: 'https://acme.com/l.png', dark: ' https://acme.com/d.png ' } })).toEqual({
      ok: true,
      branding: { logo: { light: 'https://acme.com/l.png', dark: 'https://acme.com/d.png' } },
    })
  })

  it('rejects non-https, a missing light and unknown keys', () => {
    const result = parseBranding({
      logo: { light: 'http://acme.com/l.png', dark: 'data:image/png;base64,AA', mark: 'x' },
    })
    expect(result.ok).toBe(false)
    if (result.ok) {
      return
    }
    expect(result.errors).toEqual([
      'logo.mark: unknown key',
      'logo.light: must be an https URL',
      'logo.dark: must be an https URL',
    ])
    expect(parseBranding({ logo: { dark: 'https://acme.com/d.png' } }).ok).toBe(false)
    expect(parseBranding({ logo: 'https://acme.com/l.png' }).ok).toBe(false)
  })

  it('checks the /config manifest before its names become a request path', () => {
    const light = { file: '0123456789abcdef.svg', type: 'image/svg+xml' }
    expect(isBrandingLogoManifest({ light })).toBe(true)
    expect(isBrandingLogoManifest({ light, dark: { file: 'fedcba9876543210.png', type: 'image/png' } })).toBe(true)
    expect(isBrandingLogoManifest({ light: { ...light, file: '../x.svg' } })).toBe(false)
    expect(isBrandingLogoManifest({ light: { ...light, type: 'text/html' } })).toBe(false)
    expect(isBrandingLogoManifest({ dark: light })).toBe(false)
    expect(isBrandingLogoManifest(undefined)).toBe(false)
  })
})

describe('parseFontFamilies', () => {
  it('splits a list and strips quotes', () => {
    expect(parseFontFamilies('"DM Sans", ui-sans-serif, sans-serif')).toEqual([
      'DM Sans',
      'ui-sans-serif',
      'sans-serif',
    ])
    expect(parseFontFamilies("'Times New Roman',Times")).toEqual(['Times New Roman', 'Times'])
  })

  it('rejects anything beyond plain names', () => {
    for (const value of ['DM Sans; } body {', 'url(x)', 'A, , B', '"Unclosed', 'var(--x)', '']) {
      expect(parseFontFamilies(value)).toBeNull()
    }
  })

  it('rejects unsafe font tokens in branding', () => {
    const result = parseBranding({ cssVars: { theme: { 'font-heading': 'X; } body { color: red' } } })
    expect(result.ok).toBe(false)
  })
})

describe('brandingFontFamilies', () => {
  it('resolves each slot from theme, then light, then dark', () => {
    expect(
      brandingFontFamilies({
        cssVars: {
          theme: { 'font-sans': 'Inter, sans-serif' },
          light: { 'font-sans': 'Ignored', 'font-mono': 'Space Mono' },
          dark: { 'font-heading': 'Space Grotesk' },
        },
      }),
    ).toEqual({ 'font-sans': ['Inter', 'sans-serif'], 'font-mono': ['Space Mono'], 'font-heading': ['Space Grotesk'] })
    expect(brandingFontFamilies(undefined)).toEqual({})
  })
})

describe('isBrandingFontFace', () => {
  const face = {
    family: 'DM Sans',
    style: 'normal',
    weight: '100 900',
    unicodeRange: 'U+0000-00FF, U+0131, U+02BB-02BC',
    file: '0123456789abcdef.woff2',
  }

  it('accepts a well-formed face', () => {
    expect(isBrandingFontFace(face)).toBe(true)
    expect(isBrandingFontFace({ ...face, weight: '400', style: 'italic' })).toBe(true)
  })

  it('rejects malformed fields', () => {
    expect(isBrandingFontFace({ ...face, file: '../secret.woff2' })).toBe(false)
    expect(isBrandingFontFace({ ...face, family: 'X; }' })).toBe(false)
    expect(isBrandingFontFace({ ...face, unicodeRange: 'U+0000; x' })).toBe(false)
    expect(isBrandingFontFace({ ...face, style: 'oblique' })).toBe(false)
    expect(isBrandingFontFace(null)).toBe(false)
  })
})

describe('radiusScaleFor', () => {
  it('maps shadcn radius lengths onto our scale', () => {
    expect(radiusScaleFor('0px')).toBe(0)
    expect(radiusScaleFor('0.625rem')).toBe(1)
    expect(radiusScaleFor('1.25rem')).toBe(2)
    expect(radiusScaleFor('5px')).toBe(0.5)
  })
})

describe('readableForeground', () => {
  it('picks ink on light colors and off-white on dark ones, in any format', () => {
    expect(readableForeground('#ffffff')).toBe('#262120')
    expect(readableForeground('#1e293b')).toBe('#faf8f5')
    expect(readableForeground('oklch(1 0 0)')).toBe('#262120')
    expect(readableForeground('oklch(0.5 0.2 260)')).toBe('#faf8f5')
    // Bright red reads marginally better with dark text, same as its hex twin.
    expect(readableForeground('oklch(0.6489 0.2370 26.9728)')).toBe(readableForeground('#ff3333'))
    expect(readableForeground('hsl(48 96% 89%)')).toBe('#262120')
    expect(readableForeground('rgb(17 17 17)')).toBe('#faf8f5')
    expect(readableForeground('oklab(0.2 0 0)')).toBe('#faf8f5')
  })

  it('judges a gradient by its worst stop', () => {
    expect(readableForeground('#fef9c3', '#111111')).toBe(readableForeground('#111111', '#fef9c3'))
  })

  it('returns null when a color cannot be evaluated', () => {
    expect(readableForeground('oklch(0.5 0.1 none)')).toBeNull()
  })
})

describe('toHexColor', () => {
  it('converts every accepted format to #rrggbb', () => {
    expect(toHexColor('#fff')).toBe('#ffffff')
    expect(toHexColor('#2563eb80')).toBe('#2563eb')
    expect(toHexColor('rgb(37 99 235)')).toBe('#2563eb')
    expect(toHexColor('hsl(0 0% 0%)')).toBe('#000000')
    expect(toHexColor('oklch(1 0 0)')).toBe('#ffffff')
  })

  it('returns null for a color it cannot evaluate', () => {
    expect(toHexColor('oklch(0.5 0.1 none)')).toBeNull()
  })
})
