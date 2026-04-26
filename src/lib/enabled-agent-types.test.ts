import { describe, expect, it } from 'bun:test'
import { parseEnabledAgentTypes } from './enabled-agent-types'

describe('parseEnabledAgentTypes', () => {
  it('should return all types when input is undefined', () => {
    const result = parseEnabledAgentTypes(undefined)
    expect(result).toEqual(new Set(['built-in', 'local', 'remote']))
  })

  it('should return all types when input is empty string', () => {
    const result = parseEnabledAgentTypes('')
    expect(result).toEqual(new Set(['built-in', 'local', 'remote']))
  })

  it('should parse a single type', () => {
    const result = parseEnabledAgentTypes('remote')
    expect(result).toEqual(new Set(['remote']))
  })

  it('should parse multiple comma-separated types', () => {
    const result = parseEnabledAgentTypes('built-in,remote')
    expect(result).toEqual(new Set(['built-in', 'remote']))
  })

  it('should parse all three types', () => {
    const result = parseEnabledAgentTypes('built-in,local,remote')
    expect(result).toEqual(new Set(['built-in', 'local', 'remote']))
  })

  it('should trim whitespace around types', () => {
    const result = parseEnabledAgentTypes(' built-in , remote ')
    expect(result).toEqual(new Set(['built-in', 'remote']))
  })

  it('should ignore invalid type values', () => {
    const result = parseEnabledAgentTypes('built-in,invalid,remote,foo')
    expect(result).toEqual(new Set(['built-in', 'remote']))
  })

  it('should return empty set when all values are invalid', () => {
    const result = parseEnabledAgentTypes('invalid,foo,bar')
    expect(result).toEqual(new Set())
  })

  it('should handle duplicate types', () => {
    const result = parseEnabledAgentTypes('remote,remote,built-in')
    expect(result).toEqual(new Set(['remote', 'built-in']))
  })
})
