/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { i18n } from '@lingui/core'
import { describe, expect, it } from 'bun:test'
import { getProviderDisplay, getProviderLabel, providerPickerOrder } from './model-presentation'

describe('provider labels', () => {
  it('names managed models after the deployment, custom with copy, and the rest by brand', () => {
    expect(getProviderLabel(i18n, 'thunderbolt', 'Acme AI')).toBe('Acme AI')
    expect(getProviderLabel(i18n, 'custom', 'Acme AI')).toBe('Custom')
    expect(getProviderLabel(i18n, 'openai', 'Acme AI')).toBe('OpenAI')
  })

  it('treats system Tinfoil as a managed model, and user Tinfoil as Tinfoil', () => {
    expect(getProviderDisplay(i18n, { provider: 'tinfoil', isSystem: 1 }, 'Acme AI')).toBe('Acme AI')
    expect(getProviderDisplay(i18n, { provider: 'tinfoil', isSystem: 0 }, 'Acme AI')).toBe('Tinfoil')
  })

  it('lists every provider in picker order, managed first', () => {
    expect(providerPickerOrder).toEqual(['thunderbolt', 'tinfoil', 'openai', 'openrouter', 'anthropic', 'custom'])
  })
})
