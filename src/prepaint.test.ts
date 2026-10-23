/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// index.html applies the theme, background and title before any module loads,
// so it repeats rules the app owns. These checks keep the copies identical.

import { useConfigStore } from '@/api/config-store'
import { migrateLocalSettings, useLocalSettingsStore } from '@/stores/local-settings-store'
import { prePaintRules } from '@shared/branding'
import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const indexHtml = readFileSync(join(import.meta.dir, '..', 'index.html'), 'utf8')

describe('index.html pre-paint script', () => {
  it('reads the stores under their persisted names', () => {
    expect(indexHtml).toContain(`readState('${useConfigStore.persist.getOptions().name}')`)
    expect(indexHtml).toContain(`readState('${useLocalSettingsStore.persist.getOptions().name}')`)
  })

  it('reads the local-settings version the migration targets', () => {
    expect(useLocalSettingsStore.persist.getOptions().version).toBe(1)
    expect(indexHtml).toContain('settings.version >= 1')
  })

  it('checks colors, theme modes and the app name as shared/branding.ts does', () => {
    expect(indexHtml).toContain(prePaintRules.hexColorPattern.toString())
    expect(indexHtml).toContain(prePaintRules.functionColorPattern.toString())
    expect(indexHtml).toContain(`[${prePaintRules.themeModes.map((mode) => `'${mode}'`).join(', ')}]`)
    expect(indexHtml).toContain(`appName.length <= ${prePaintRules.nameMaxLength}`)
  })

  it("falls back to the theme's own light and dark backgrounds", () => {
    const indexCss = readFileSync(join(import.meta.dir, 'index.css'), 'utf8')
    const [lightBackground, darkBackground] = [...indexCss.matchAll(/^\s*--color-background:\s*([^;]+);/gm)].map(
      ([, value]) => value,
    )
    expect(indexHtml).toContain(`isDark ? '${darkBackground}' : '${lightBackground}'`)
  })
})

describe('migrateLocalSettings', () => {
  it("reads a pre-version-1 'system' theme as unset, since it was the default rather than a choice", () => {
    expect(migrateLocalSettings({ theme: 'system', hapticsEnabled: false }, 0)).toEqual({
      theme: null,
      hapticsEnabled: false,
    })
  })

  it('keeps a theme the user picked, and anything stored under version 1', () => {
    expect(migrateLocalSettings({ theme: 'dark' }, 0)).toEqual({ theme: 'dark' })
    expect(migrateLocalSettings({ theme: 'system' }, 1)).toEqual({ theme: 'system' })
  })

  it('tolerates storage that is not an object', () => {
    expect(migrateLocalSettings(null, 0)).toEqual({})
  })
})
