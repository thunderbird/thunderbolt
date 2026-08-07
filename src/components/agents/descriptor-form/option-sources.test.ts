/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'bun:test'
import type { AgentField } from '@shared/agent-descriptors'
import { fieldOptions, fieldOptionsLoading, type OptionSources } from './option-sources'

const base = { key: 'model', label: 'Model', widget: 'select' } as const

const inlineField: AgentField = {
  ...base,
  source: { kind: 'inline', options: [{ value: 'a', label: 'A' }] },
}
const fetchedField: AgentField = {
  ...base,
  source: { kind: 'fetched', sourceId: 'account-models' },
}
const noSourceField: AgentField = { ...base }

describe('fieldOptions', () => {
  it('returns inline options verbatim', () => {
    expect(fieldOptions(inlineField, {})).toEqual([{ value: 'a', label: 'A' }])
  })

  it('resolves a fetched source from the registry', () => {
    const sources: OptionSources = {
      'account-models': { options: [{ value: 'gpt', label: 'GPT' }], isLoading: false },
    }
    expect(fieldOptions(fetchedField, sources)).toEqual([{ value: 'gpt', label: 'GPT' }])
  })

  it('returns [] when the fetched source is missing from the registry', () => {
    expect(fieldOptions(fetchedField, {})).toEqual([])
  })

  it('returns [] for a field with no source', () => {
    expect(fieldOptions(noSourceField, {})).toEqual([])
  })
})

describe('fieldOptionsLoading', () => {
  it('is false for inline sources', () => {
    expect(fieldOptionsLoading(inlineField, {})).toBe(false)
  })

  it('is false for a field with no source', () => {
    expect(fieldOptionsLoading(noSourceField, {})).toBe(false)
  })

  it('reflects the resolved fetched source loading flag', () => {
    const loading: OptionSources = { 'account-models': { options: [], isLoading: true } }
    expect(fieldOptionsLoading(fetchedField, loading)).toBe(true)
  })

  it('is false when the fetched source is missing from the registry', () => {
    expect(fieldOptionsLoading(fetchedField, {})).toBe(false)
  })
})
