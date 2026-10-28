/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'bun:test'
import { Elysia } from 'elysia'
import { createTestSettings } from '@/test-utils/settings'
import { defaultModelId, defaultModels, defaultModelsVersion } from '@shared/defaults/models'
import { noBrandingAssets, type BrandingAssets } from '@/branding/assets'
import type { BrandingFile } from '@/branding/download'
import { createConfigRoutes } from './config'

const fetchConfig = async (settings: Parameters<typeof createConfigRoutes>[0]) => {
  const app = new Elysia().use(createConfigRoutes(settings, noBrandingAssets))
  const response = await app.handle(new Request('http://localhost/config'))
  return { status: response.status, body: await response.json() }
}

describe('Config Routes', () => {
  describe('GET /config', () => {
    it('always reports e2eeEnabled: true (stale-client compatibility shim)', async () => {
      const { body } = await fetchConfig(createTestSettings())
      expect(body.e2eeEnabled).toBe(true)
    })

    it('reflects orgEscrowEnabled', async () => {
      const disabled = await fetchConfig(createTestSettings())
      expect(disabled.body.orgEscrowEnabled).toBe(false)

      const enabled = await fetchConfig(createTestSettings({ orgEscrowEnabled: true }))
      expect(enabled.body.orgEscrowEnabled).toBe(true)
    })

    it('reflects debugTranscriptsEnabled', async () => {
      const disabled = await fetchConfig(createTestSettings({ debugTranscriptsEnabled: false }))
      expect(disabled.body.debugTranscriptsEnabled).toBe(false)

      const enabled = await fetchConfig(createTestSettings({ debugTranscriptsEnabled: true }))
      expect(enabled.body.debugTranscriptsEnabled).toBe(true)
    })

    it('exposes builtInAgentEnabled: true by default and false when disabled', async () => {
      const onByDefault = await fetchConfig(createTestSettings())
      expect(onByDefault.body.builtInAgentEnabled).toBe(true)

      const disabled = await fetchConfig(createTestSettings({ disableBuiltInAgent: true }))
      expect(disabled.body.builtInAgentEnabled).toBe(false)
    })

    it('exposes minimalMode: false by default and true when set', async () => {
      const offByDefault = await fetchConfig(createTestSettings())
      expect(offByDefault.body.minimalMode).toBe(false)

      const minimal = await fetchConfig(createTestSettings({ minimalMode: true }))
      expect(minimal.body.minimalMode).toBe(true)
    })

    it('exposes the brand logo fields, empty by default', async () => {
      const unset = await fetchConfig(createTestSettings())
      expect(unset.body).toMatchObject({ brandLogoUrl: '', brandLogoDarkUrl: '', brandLogoAlt: '' })

      const set = await fetchConfig(
        createTestSettings({
          brandLogoUrl: 'https://example.com/logo.svg',
          brandLogoDarkUrl: 'data:image/svg+xml,dark',
          brandLogoAlt: 'Example',
        }),
      )
      expect(set.body).toMatchObject({
        brandLogoUrl: 'https://example.com/logo.svg',
        brandLogoDarkUrl: 'data:image/svg+xml,dark',
        brandLogoAlt: 'Example',
      })
    })

    it('exposes allowCustomAgents', async () => {
      const allowed = await fetchConfig(createTestSettings({ allowCustomAgents: true }))
      expect(allowed.body.allowCustomAgents).toBe(true)

      const forbidden = await fetchConfig(createTestSettings({ allowCustomAgents: false }))
      expect(forbidden.body.allowCustomAgents).toBe(false)
    })

    it('omits minAppVersion when MIN_APP_VERSION is unset', async () => {
      const { body } = await fetchConfig(createTestSettings())
      expect(body.minAppVersion).toBeUndefined()
    })

    it('exposes minAppVersion when set', async () => {
      const { body } = await fetchConfig(createTestSettings({ minAppVersion: '0.2.0' }))
      expect(body.minAppVersion).toBe('0.2.0')
    })

    it('omits branding when BRANDING is unset', async () => {
      const { body } = await fetchConfig(createTestSettings())
      expect(body).not.toHaveProperty('branding')
    })

    it('exposes branding when set', async () => {
      const branding = { appName: 'Acme AI', cssVars: { theme: { radius: '1rem' }, light: { brand: '#2563eb' } } }
      const { body } = await fetchConfig(createTestSettings({ branding }))
      expect(body.branding).toEqual(branding)
    })

    describe('branding files', () => {
      const face = {
        family: 'DM Sans',
        style: 'normal' as const,
        weight: '100 900',
        unicodeRange: 'U+0000-00FF',
        file: '0123456789abcdef0123456789abcdef.woff2',
      }
      const light = { file: 'fedcba9876543210fedcba9876543210.png', type: 'image/png' as const }
      const dark = { file: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.svg', type: 'image/svg+xml' as const }
      const files: BrandingFile[] = [
        { name: face.file, bytes: new Uint8Array([1, 2, 3]), type: 'font/woff2' },
        { name: light.file, bytes: new TextEncoder().encode('PNG'), type: light.type },
        { name: dark.file, bytes: new TextEncoder().encode('<svg/>'), type: dark.type },
      ]
      const assets: BrandingAssets = {
        fonts: () => [face],
        logo: () => ({ light, dark }),
        file: (name) => files.find((file) => file.name === name),
      }
      const branding = { appName: 'Acme AI', logo: { light: 'https://acme.test/light.png' } }
      const appWith = (brandingAssets: BrandingAssets) =>
        new Elysia().use(
          createConfigRoutes(
            createTestSettings({ branding, appUrl: 'https://app.acme.test', betterAuthUrl: 'https://api.acme.test' }),
            brandingAssets,
          ),
        )
      const get = (app: ReturnType<typeof appWith>, path: string) => app.handle(new Request(`http://localhost${path}`))

      it('lists the fonts and logo inside branding, in place of the logo URLs', async () => {
        const config = await (await get(appWith(assets), '/config')).json()
        expect(config.branding).toEqual({ appName: 'Acme AI', fonts: [face], logo: { light, dark } })
      })

      it('omits fonts and logo until their downloads land', async () => {
        const config = await (await get(appWith(noBrandingAssets), '/config')).json()
        expect(config.branding).toEqual({ appName: 'Acme AI' })
      })

      it('serves a file by name, cacheable forever', async () => {
        const font = await get(appWith(assets), `/config/branding/${face.file}`)
        expect(font.status).toBe(200)
        expect(font.headers.get('content-type')).toBe('font/woff2')
        expect(font.headers.get('cache-control')).toBe('public, max-age=31536000, immutable')
        expect(new Uint8Array(await font.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]))

        const missing = await get(appWith(assets), '/config/branding/ffffffffffffffffffffffffffffffff.png')
        expect(missing.status).toBe(404)
      })

      it('sandboxes an SVG so opening it directly cannot run script', async () => {
        const svg = await get(appWith(assets), `/config/branding/${dark.file}`)
        expect(svg.headers.get('content-type')).toBe('image/svg+xml')
        expect(svg.headers.get('content-security-policy')).toBe('sandbox')
        expect(svg.headers.get('x-content-type-options')).toBe('nosniff')
        expect(svg.headers.get('content-disposition')).toBe('attachment')
      })

      it('serves the light logo to emails when it is PNG or JPEG, sandboxed and re-checked hourly', async () => {
        const logo = await get(appWith(assets), '/config/branding/email-logo')
        expect(logo.status).toBe(200)
        expect(logo.headers.get('content-type')).toBe('image/png')
        expect(logo.headers.get('content-security-policy')).toBe('sandbox')
        expect(logo.headers.get('cache-control')).toBe('public, max-age=3600')
        expect(await logo.text()).toBe('PNG')

        const jpeg = { file: 'cccccccccccccccccccccccccccccccc.jpg', type: 'image/jpeg' as const }
        const jpegAssets: BrandingAssets = {
          ...assets,
          logo: () => ({ light: jpeg }),
          file: (name) =>
            name === jpeg.file ? { name, bytes: new TextEncoder().encode('JPG'), type: jpeg.type } : undefined,
        }
        expect(await (await get(appWith(jpegAssets), '/config/branding/email-logo')).text()).toBe('JPG')
      })

      it('publishes only the public fields, never the logo URLs or unknown extras', async () => {
        // As if a server-only field were added to Branding later.
        const withServerOnlyField = { ...branding, debugTranscriptRecipient: 'Acme IT', secret: 'server-only' }
        const app = new Elysia().use(
          createConfigRoutes(createTestSettings({ branding: withServerOnlyField }), noBrandingAssets),
        )
        const config = await (await get(app, '/config')).json()
        expect(config.branding).toEqual({ appName: 'Acme AI', debugTranscriptRecipient: 'Acme IT' })
      })

      it('redirects emails to the bundled mark for an SVG logo or one still downloading', async () => {
        const svgOnly = { ...assets, logo: () => ({ light: dark }) }
        for (const brandingAssets of [svgOnly, noBrandingAssets]) {
          const logo = await get(appWith(brandingAssets), '/config/branding/email-logo')
          expect(logo.status).toBe(302)
          expect(logo.headers.get('location')).toBe('https://app.acme.test/email-logo.png')
          expect(logo.headers.get('cache-control')).toBe('public, max-age=3600')
        }
      })
    })

    it('reports passkeys off by default', async () => {
      const { body } = await fetchConfig(createTestSettings())
      expect(body.passkeyEnabled).toBe(false)
      expect(body.passkeyRpId).toBeUndefined()
    })

    it('reports passkeys on when the operator enables them', async () => {
      const { body } = await fetchConfig(createTestSettings({ passkeyEnabled: true, passkeyRpId: 'localhost' }))
      expect(body.passkeyEnabled).toBe(true)
      expect(body.passkeyRpId).toBe('localhost')
    })

    it('keeps passkeys off in SSO modes even when enabled', async () => {
      const { body } = await fetchConfig(createTestSettings({ passkeyEnabled: true, authMode: 'oidc' }))
      expect(body.passkeyEnabled).toBe(false)
    })

    it('does not require authentication', async () => {
      const { status } = await fetchConfig(createTestSettings())
      expect(status).toBe(200)
    })

    it('ships models defaults with their shared version', async () => {
      const { body } = await fetchConfig(createTestSettings())
      expect(body.defaults.models.version).toBe(defaultModelsVersion)
      expect(body.defaults.models.data).toEqual(defaultModels)
    })

    it('publishes the default model id without private runtime fields', async () => {
      const { body } = await fetchConfig(createTestSettings())

      expect(body.defaults.models.defaultModelId).toBe(defaultModelId)
      expect(body.defaults.models.data.some(({ id }: { id: string }) => id === defaultModelId)).toBe(true)
      const serialized = JSON.stringify(body.defaults.models)
      expect(serialized).not.toContain('"internalName"')
      expect(serialized).not.toContain('"price"')
    })
  })
})
