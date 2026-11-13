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
    expect(getProviderLabel(i18n, 'otari', 'Acme AI')).toBe('Otari')
    expect(getProviderLabel(i18n, 'privatemode', 'Acme AI')).toBe('Privatemode')
    expect(getProviderDisplay(i18n, { provider: 'otari', isSystem: 0 }, 'Acme AI')).toBe('Otari')
    expect(getProviderDisplay(i18n, { provider: 'openrouter', isSystem: 0 }, 'Acme AI')).toBe('OpenRouter')
  })

  it('treats system Tinfoil as a managed model, and user Tinfoil as Tinfoil', () => {
    expect(getProviderDisplay(i18n, { provider: 'tinfoil', isSystem: 1 }, 'Acme AI')).toBe('Acme AI')
    expect(getProviderDisplay(i18n, { provider: 'tinfoil', isSystem: 0 }, 'Acme AI')).toBe('Tinfoil')
  })

  it('lists every provider in picker order, managed first', () => {
    expect(providerPickerOrder).toEqual([
      'thunderbolt',
      'tinfoil',
      'privatemode',
      'otari',
      'openai',
      'openrouter',
      'anthropic',
      'custom',
    ])
  })

  it('includes the named account without repeating an identical provider name', () => {
    expect(getProviderDisplay(i18n, { provider: 'openai', isSystem: 0, connectionName: 'Work' }, 'App')).toBe(
      'OpenAI · Work',
    )
    expect(getProviderDisplay(i18n, { provider: 'otari', isSystem: 0, connectionName: 'Otari' }, 'App')).toBe('Otari')
    expect(
      getProviderDisplay(i18n, { provider: 'tinfoil', isSystem: 1, connectionName: 'Hidden transport' }, 'App'),
    ).toBe('App')
  })
})
