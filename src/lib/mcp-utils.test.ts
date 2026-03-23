import { describe, expect, it } from 'bun:test'
import { validateMcpUrl, validateStdioArgs, validateStdioCommand } from './mcp-utils'

describe('validateMcpUrl', () => {
  it('accepts valid http/https URLs', () => {
    expect(validateMcpUrl('http://localhost:8000/mcp/')).toBeInstanceOf(URL)
    expect(validateMcpUrl('https://api.example.com/mcp').hostname).toBe('api.example.com')
  })

  it('throws on invalid URL string', () => {
    expect(() => validateMcpUrl('not a url')).toThrow()
  })

  it('throws on non-http protocols', () => {
    expect(() => validateMcpUrl('ftp://example.com/mcp')).toThrow('URL must use http: or https: protocol')
  })

  it('throws on javascript: protocol', () => {
    expect(() => validateMcpUrl('javascript:alert(1)')).toThrow('URL must use http: or https: protocol')
  })
})

describe('validateStdioCommand', () => {
  it('accepts valid command names', () => {
    expect(() => validateStdioCommand('npx')).not.toThrow()
    expect(() => validateStdioCommand('/usr/local/bin/mcp-server')).not.toThrow()
    expect(() => validateStdioCommand('mcp-server.sh')).not.toThrow()
  })

  it('throws on empty command', () => {
    expect(() => validateStdioCommand('')).toThrow('Command is required')
    expect(() => validateStdioCommand('   ')).toThrow('Command is required')
  })

  it('rejects shell meta-characters', () => {
    expect(() => validateStdioCommand('npx; rm -rf /')).toThrow('Command contains invalid characters')
    expect(() => validateStdioCommand('npx | cat')).toThrow('Command contains invalid characters')
    expect(() => validateStdioCommand('$(whoami)')).toThrow('Command contains invalid characters')
    expect(() => validateStdioCommand('`id`')).toThrow('Command contains invalid characters')
  })
})

describe('validateStdioArgs', () => {
  it('accepts normal args', () => {
    expect(() => validateStdioArgs(['--port', '8080', '--verbose'])).not.toThrow()
  })

  it('throws when any arg contains null byte', () => {
    expect(() => validateStdioArgs(['--port', 'val\0ue'])).toThrow('Arguments must not contain null bytes')
  })
})
