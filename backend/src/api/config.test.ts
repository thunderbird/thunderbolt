/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'bun:test'
import { Elysia } from 'elysia'
import { createTestSettings } from '@/test-utils/settings'
import { defaultModelId, defaultModels, defaultModelsVersion } from '@shared/defaults/models'
import { noBrandingFonts } from '@/branding/fonts'
import { noBrandingLogo } from '@/branding/logo'
import { createConfigRoutes } from './config'

const fetchConfig = async (settings: Parameters<typeof createConfigRoutes>[0]) => {
  const app = new Elysia().use(createConfigRoutes(settings, { fonts: noBrandingFonts, logo: noBrandingLogo }))
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

    it('names the debug-transcript recipient', async () => {
      const defaulted = await fetchConfig(createTestSettings())
      expect(defaulted.body.debugTranscriptRecipientName).toBe('Thunderbolt')

      const named = await fetchConfig(createTestSettings({ debugTranscriptRecipientName: 'Acme' }))
      expect(named.body.debugTranscriptRecipientName).toBe('Acme')
    })

    it('omits branding when BRANDING_JSON is unset', async () => {
      const { body } = await fetchConfig(createTestSettings())
      expect(body).not.toHaveProperty('branding')
    })

    it('exposes branding when set', async () => {
      const branding = { appName: 'Acme AI', cssVars: { theme: { radius: '1rem' }, light: { brand: '#2563eb' } } }
      const { body } = await fetchConfig(createTestSettings({ branding }))
      expect(body.branding).toEqual(branding)
    })

    it('lists resolved branding fonts and serves their files', async () => {
      const face = {
        family: 'DM Sans',
        style: 'normal' as const,
        weight: '100 900',
        unicodeRange: 'U+0000-00FF',
        file: '0123456789abcdef.woff2',
      }
      const fonts = {
        faces: () => [face],
        file: (name: string) => (name === face.file ? new Uint8Array([1, 2, 3]) : undefined),
      }
      const app = new Elysia().use(createConfigRoutes(createTestSettings(), { fonts, logo: noBrandingLogo }))

      const config = await (await app.handle(new Request('http://localhost/config'))).json()
      expect(config.brandingFonts).toEqual([face])

      const file = await app.handle(new Request(`http://localhost/config/fonts/${face.file}`))
      expect(file.status).toBe(200)
      expect(file.headers.get('content-type')).toBe('font/woff2')
      expect(file.headers.get('cache-control')).toBe('public, max-age=31536000, immutable')
      expect(new Uint8Array(await file.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]))

      const missing = await app.handle(new Request('http://localhost/config/fonts/ffffffffffffffff.woff2'))
      expect(missing.status).toBe(404)
    })

    it('lists the downloaded logo and serves it with its type', async () => {
      const light = { file: '0123456789abcdef.svg', type: 'image/svg+xml' as const }
      const logo = {
        manifest: () => ({ light }),
        file: (name: string) =>
          name === light.file ? { bytes: new TextEncoder().encode('<svg/>'), type: light.type } : undefined,
      }
      const app = new Elysia().use(createConfigRoutes(createTestSettings(), { fonts: noBrandingFonts, logo }))

      const config = await (await app.handle(new Request('http://localhost/config'))).json()
      expect(config.brandingLogo).toEqual({ light })

      const file = await app.handle(new Request(`http://localhost/config/logo/${light.file}`))
      expect(file.headers.get('content-type')).toBe('image/svg+xml')
      expect(file.headers.get('cache-control')).toBe('public, max-age=31536000, immutable')
      expect(await file.text()).toBe('<svg/>')

      expect((await app.handle(new Request('http://localhost/config/logo/ffffffffffffffff.png'))).status).toBe(404)
    })

    it('omits brandingLogo when none downloaded', async () => {
      const { body } = await fetchConfig(createTestSettings())
      expect(body).not.toHaveProperty('brandingLogo')
    })

    it('omits brandingFonts when none resolved', async () => {
      const { body } = await fetchConfig(createTestSettings())
      expect(body).not.toHaveProperty('brandingFonts')
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
