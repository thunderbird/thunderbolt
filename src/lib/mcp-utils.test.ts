import { describe, expect, it } from 'bun:test'
import { validateMcpUrl, validateStdioArgs, validateStdioCommand } from './mcp-utils'

describe('validateMcpUrl', () => {
  it('accepts http URLs', () => {
    const result = validateMcpUrl('http://localhost:8000/mcp/')
    expect(result.hostname).toBe('localhost')
  })

  it('accepts https URLs', () => {
    const result = validateMcpUrl('https://api.example.com/mcp')
    expect(result.hostname).toBe('api.example.com')
  })

  it('returns a URL object', () => {
    const result = validateMcpUrl('http://localhost:8000/mcp/')
    expect(result).toBeInstanceOf(URL)
  })

  it('throws on invalid URL string', () => {
    expect(() => validateMcpUrl('not a url')).toThrow()
  })

  it('throws on ftp protocol', () => {
    expect(() => validateMcpUrl('ftp://example.com/mcp')).toThrow('URL must use http: or https: protocol')
  })

  it('throws on javascript: protocol', () => {
    expect(() => validateMcpUrl('javascript:alert(1)')).toThrow('URL must use http: or https: protocol')
  })

  it('throws on data: protocol', () => {
    expect(() => validateMcpUrl('data:text/html,<h1>hello</h1>')).toThrow('URL must use http: or https: protocol')
  })

  it('throws on empty string', () => {
    expect(() => validateMcpUrl('')).toThrow()
  })
})

describe('validateStdioCommand', () => {
  it('accepts simple binary names', () => {
    expect(() => validateStdioCommand('npx')).not.toThrow()
    expect(() => validateStdioCommand('uvx')).not.toThrow()
    expect(() => validateStdioCommand('node')).not.toThrow()
    expect(() => validateStdioCommand('python3')).not.toThrow()
    expect(() => validateStdioCommand('bun')).not.toThrow()
  })

  it('accepts paths with slashes', () => {
    expect(() => validateStdioCommand('/usr/local/bin/mcp-server')).not.toThrow()
    expect(() => validateStdioCommand('./bin/server')).not.toThrow()
  })

  it('accepts names with dots and hyphens', () => {
    expect(() => validateStdioCommand('mcp-server.sh')).not.toThrow()
  })

  it('throws on empty command', () => {
    expect(() => validateStdioCommand('')).toThrow('Command is required')
  })

  it('throws on whitespace-only command', () => {
    expect(() => validateStdioCommand('   ')).toThrow('Command is required')
  })

  it('throws on command with semicolon', () => {
    expect(() => validateStdioCommand('npx; rm -rf /')).toThrow('Command contains invalid characters')
  })

  it('throws on command with pipe', () => {
    expect(() => validateStdioCommand('npx | cat')).toThrow('Command contains invalid characters')
  })

  it('throws on command with dollar sign', () => {
    expect(() => validateStdioCommand('$PATH')).toThrow('Command contains invalid characters')
  })

  it('throws on command with backtick', () => {
    expect(() => validateStdioCommand('`whoami`')).toThrow('Command contains invalid characters')
  })

  it('throws on command with spaces', () => {
    expect(() => validateStdioCommand('node server')).toThrow('Command contains invalid characters')
  })
})

describe('validateStdioArgs', () => {
  it('accepts normal args', () => {
    expect(() => validateStdioArgs(['--port', '8080', '--verbose'])).not.toThrow()
  })

  it('accepts args with special characters (non-null)', () => {
    expect(() => validateStdioArgs(['--key=value', '-x', 'some/path'])).not.toThrow()
  })

  it('accepts empty array', () => {
    expect(() => validateStdioArgs([])).not.toThrow()
  })

  it('throws when any arg contains null byte', () => {
    expect(() => validateStdioArgs(['--port', 'val\0ue'])).toThrow('Arguments must not contain null bytes')
  })

  it('throws on null byte at start of arg', () => {
    expect(() => validateStdioArgs(['\0malicious'])).toThrow('Arguments must not contain null bytes')
  })

  it('throws on null byte at end of arg', () => {
    expect(() => validateStdioArgs(['arg\0'])).toThrow('Arguments must not contain null bytes')
  })
})
