/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'bun:test'
import {
  agentCatalogResponseSchema,
  agentDescriptorSchema,
  allFields,
  defaultSpec,
  deployRequestSchema,
  deployResponseSchema,
  deploymentStatusResponseSchema,
  fieldSchema,
  isFieldVisible,
  isOneClickEligible,
  optionSourceSchema,
  schemaVersionMismatch,
  specSchemaForDescriptor,
  visibleFields,
  widgetSchema,
  type AgentDescriptor,
} from './agent-descriptors.ts'

const makeDescriptor = (overrides: Partial<AgentDescriptor> = {}): AgentDescriptor => ({
  id: 'haystack',
  provider: 'haystack',
  name: 'Haystack',
  description: 'Deploy a Deepset pipeline',
  icon: 'file-search',
  schemaVersion: 1,
  action: 'deploy',
  steps: [
    {
      id: 'basics',
      title: 'Basics',
      fields: [
        { key: 'name', label: 'Name', widget: 'text', required: true, maxLength: 40 },
        { key: 'mode', label: 'Mode', widget: 'select', default: 'curated' },
        {
          key: 'apiKey',
          label: 'API key',
          widget: 'password',
          required: true,
          visibleWhen: { field: 'mode', equals: 'byo' },
        },
        { key: 'files', label: 'Files', widget: 'gallery' },
      ],
    },
  ],
  ...overrides,
})

describe('widget + field schemas', () => {
  it('accepts the closed widget set', () => {
    expect(widgetSchema.parse('option-cards')).toBe('option-cards')
  })

  it('rejects an unknown widget', () => {
    expect(() => widgetSchema.parse('slider')).toThrow()
  })

  it('parses a minimal field', () => {
    expect(fieldSchema.parse({ key: 'name', label: 'Name', widget: 'text' }).key).toBe('name')
  })

  it('parses inline and fetched option sources', () => {
    expect(optionSourceSchema.parse({ kind: 'inline', options: [{ value: 'a', label: 'A' }] }).kind).toBe('inline')
    expect(optionSourceSchema.parse({ kind: 'fetched', sourceId: 'indexes' }).kind).toBe('fetched')
  })

  it('rejects an option source with an unknown kind', () => {
    expect(() => optionSourceSchema.parse({ kind: 'remote' })).toThrow()
  })
})

describe('descriptor + response schemas', () => {
  it('round-trips a valid descriptor', () => {
    expect(() => agentDescriptorSchema.parse(makeDescriptor())).not.toThrow()
  })

  it('rejects a descriptor missing provider', () => {
    const { provider: _provider, ...rest } = makeDescriptor()
    expect(() => agentDescriptorSchema.parse(rest)).toThrow()
  })

  it('parses the catalog envelope', () => {
    const parsed = agentCatalogResponseSchema.parse({ version: '1', descriptors: [makeDescriptor()] })
    expect(parsed.descriptors).toHaveLength(1)
  })

  it('parses deploy request/response and deployment status', () => {
    expect(
      deployRequestSchema.parse({ descriptorId: 'haystack', schemaVersion: 1, spec: { name: 'x' } }).spec.name,
    ).toBe('x')
    expect(deployResponseSchema.parse({ deploymentId: 'haystack:tb-x', status: 'pending' }).status).toBe('pending')
    const status = deploymentStatusResponseSchema.parse({
      deploymentId: 'haystack:tb-x',
      status: 'running',
      connection: { url: 'wss://h/v1/haystack/ws?pipeline=tb-x', transport: 'websocket' },
    })
    expect(status.connection?.url).toContain('wss://')
  })

  it('rejects an invalid deploy status', () => {
    expect(() => deployResponseSchema.parse({ deploymentId: 'x', status: 'deployed' })).toThrow()
  })

  it('exposes the schema-version-mismatch code', () => {
    expect(schemaVersionMismatch).toBe('SCHEMA_VERSION_MISMATCH')
  })
})

describe('field helpers', () => {
  it('flattens fields across steps', () => {
    expect(allFields(makeDescriptor()).map((f) => f.key)).toEqual(['name', 'mode', 'apiKey', 'files'])
  })

  it('treats fields without visibleWhen as always visible', () => {
    const [name] = allFields(makeDescriptor())
    expect(isFieldVisible(name, {})).toBe(true)
  })

  it('honors visibleWhen equality', () => {
    const apiKey = allFields(makeDescriptor()).find((f) => f.key === 'apiKey')!
    expect(isFieldVisible(apiKey, { mode: 'curated' })).toBe(false)
    expect(isFieldVisible(apiKey, { mode: 'byo' })).toBe(true)
  })

  it('lists only visible fields for the current spec', () => {
    expect(visibleFields(makeDescriptor(), { mode: 'curated' }).map((f) => f.key)).toEqual(['name', 'mode', 'files'])
    expect(visibleFields(makeDescriptor(), { mode: 'byo' }).map((f) => f.key)).toEqual([
      'name',
      'mode',
      'apiKey',
      'files',
    ])
  })
})

describe('defaultSpec + one-click eligibility', () => {
  it('seeds visible defaults only', () => {
    expect(defaultSpec(makeDescriptor())).toEqual({ mode: 'curated' })
  })

  it('is not one-click when a visible required field lacks a default', () => {
    expect(isOneClickEligible(makeDescriptor())).toBe(false)
  })

  it('is one-click when every visible required field has a default', () => {
    const descriptor = makeDescriptor({
      steps: [
        {
          id: 'basics',
          title: 'Basics',
          fields: [{ key: 'name', label: 'Name', widget: 'text', required: true, default: 'My agent' }],
        },
      ],
    })
    expect(isOneClickEligible(descriptor)).toBe(true)
  })
})

describe('specSchemaForDescriptor (backend re-validation)', () => {
  it('enforces required visible fields', () => {
    const schema = specSchemaForDescriptor(makeDescriptor())
    expect(schema.safeParse({ mode: 'curated' }).success).toBe(false)
    expect(schema.safeParse({ name: 'My agent', mode: 'curated' }).success).toBe(true)
  })

  it('skips required fields that are hidden by visibleWhen', () => {
    const schema = specSchemaForDescriptor(makeDescriptor())
    // apiKey is required but hidden while mode=curated
    expect(schema.safeParse({ name: 'My agent', mode: 'curated' }).success).toBe(true)
    // once mode=byo, apiKey becomes required
    expect(schema.safeParse({ name: 'My agent', mode: 'byo' }).success).toBe(false)
    expect(schema.safeParse({ name: 'My agent', mode: 'byo', apiKey: 'sk-1' }).success).toBe(true)
  })

  it('strips unknown keys', () => {
    const schema = specSchemaForDescriptor(makeDescriptor())
    const parsed = schema.parse({ name: 'My agent', mode: 'curated', bogus: 'x' })
    expect('bogus' in parsed).toBe(false)
  })

  it('enforces maxLength', () => {
    const schema = specSchemaForDescriptor(makeDescriptor())
    expect(schema.safeParse({ name: 'x'.repeat(41), mode: 'curated' }).success).toBe(false)
  })

  it('shapes gallery/multiple fields as arrays and rejects scalars', () => {
    const schema = specSchemaForDescriptor(makeDescriptor())
    expect(schema.safeParse({ name: 'My agent', mode: 'curated', files: ['a', 'b'] }).success).toBe(true)
    expect(schema.safeParse({ name: 'My agent', mode: 'curated', files: 'a' }).success).toBe(false)
  })
})
