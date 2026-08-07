/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, test } from 'bun:test'
import {
  buildRunSpecMeta,
  detachedTurnsCapabilityMeta,
  mergeAcpMeta,
  readRunSpec,
  sameRunSpec,
  supportsDetachedTurns,
  type RunSpec,
} from './acp-types.ts'
import { buildWireSkillsMeta, readWireSkills, skillsCapabilityMeta } from './agent-core/skills.ts'

const spec: RunSpec = { modelId: 'sonnet-4.7', thinkingLevel: 'high' }

describe('run spec metadata', () => {
  test('round-trips through the wire payload', () => {
    expect(readRunSpec(buildRunSpecMeta(spec))).toEqual(spec)
  })

  test('rejects a missing, empty, or malformed spec instead of guessing one', () => {
    expect(readRunSpec(undefined)).toBeNull()
    expect(readRunSpec(null)).toBeNull()
    expect(readRunSpec({})).toBeNull()
    expect(readRunSpec({ 'thunderbird.net/thunderbolt': {} })).toBeNull()
    expect(readRunSpec(buildRunSpecMeta({ ...spec, modelId: '  ' }))).toBeNull()
    expect(readRunSpec({ 'thunderbird.net/thunderbolt': { run: { modelId: 'm' } } })).toBeNull()
    expect(readRunSpec({ 'thunderbird.net/thunderbolt': { run: { modelId: 'm', thinkingLevel: 'ultra' } } })).toBeNull()
    expect(readRunSpec({ 'thunderbird.net/thunderbolt': { run: [spec] } })).toBeNull()
  })

  test('accepts any model id — the gateway, not this contract, owns the catalog', () => {
    const custom = { modelId: 'some-future-model:v9', thinkingLevel: 'off' } as const
    expect(readRunSpec(buildRunSpecMeta(custom))).toEqual(custom)
  })

  test('sameRunSpec distinguishes a model change from a thinking change', () => {
    expect(sameRunSpec(spec, { ...spec })).toBe(true)
    expect(sameRunSpec(spec, { ...spec, modelId: 'other' })).toBe(false)
    expect(sameRunSpec(spec, { ...spec, thinkingLevel: 'low' })).toBe(false)
  })
})

describe('mergeAcpMeta', () => {
  test('keeps skills and the run spec side by side under the shared namespace', () => {
    const skills = [{ name: 'a', description: 'd', instruction: 'i' }]
    const merged = mergeAcpMeta(buildWireSkillsMeta(skills), buildRunSpecMeta(spec))

    expect(readWireSkills(merged)).toEqual(skills)
    expect(readRunSpec(merged)).toEqual(spec)
  })

  test('merges capability payloads so both markers survive', () => {
    const merged = mergeAcpMeta(skillsCapabilityMeta, detachedTurnsCapabilityMeta)
    expect(supportsDetachedTurns(merged)).toBe(true)
    expect(merged['thunderbird.net/thunderbolt']).toEqual({ skills: true, detachedTurns: true })
  })

  test('ignores absent payloads and lets later leaves win', () => {
    const merged = mergeAcpMeta(buildRunSpecMeta(spec), null, undefined, buildRunSpecMeta({ ...spec, modelId: 'next' }))
    expect(readRunSpec(merged)?.modelId).toBe('next')
    expect(readRunSpec(merged)?.thinkingLevel).toBe('high')
  })

  test('preserves foreign namespaces untouched', () => {
    const merged = mergeAcpMeta({ 'other.example/ext': { keep: 1 } }, buildRunSpecMeta(spec))
    expect(merged['other.example/ext']).toEqual({ keep: 1 })
  })
})

describe('supportsDetachedTurns', () => {
  test('is false without the marker', () => {
    expect(supportsDetachedTurns(undefined)).toBe(false)
    expect(supportsDetachedTurns(skillsCapabilityMeta)).toBe(false)
    expect(supportsDetachedTurns({ 'thunderbird.net/thunderbolt': { detachedTurns: 'yes' } })).toBe(false)
  })
})
