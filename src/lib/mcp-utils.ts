import { isDesktop, isMobile, isTauri } from '@/lib/platform'
import type { McpTransportType } from '@/types/mcp'

type PlatformCategory = 'desktop' | 'mobile' | 'web'

/** Transport types supported on each platform */
const platformTransports: Record<PlatformCategory, McpTransportType[]> = {
  desktop: ['http', 'sse', 'stdio'],
  mobile: ['http', 'sse'],
  web: ['http', 'sse'],
}

/** Returns the platform category for transport filtering */
const getPlatformCategory = (): PlatformCategory => {
  if (isDesktop()) {
    return 'desktop'
  }
  if (isMobile()) {
    return 'mobile'
  }
  return 'web'
}

/** Returns the transport types available on the current platform */
export const getSupportedTransports = (): McpTransportType[] => platformTransports[getPlatformCategory()]

/** Checks if a transport type is supported on the current platform */
export const isSupportedTransport = (type: McpTransportType): boolean => getSupportedTransports().includes(type)

/** Returns true when the current platform may encounter CORS issues with remote MCP servers */
export const isCorsRestricted = (): boolean => !isTauri()

/**
 * Validates an MCP server URL for HTTP/SSE transport.
 * Throws with a descriptive message on invalid input.
 */
export const validateMcpUrl = (url: string): URL => {
  const parsed = new URL(url)
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error('URL must use http: or https: protocol')
  }
  return parsed
}

/**
 * Validates a stdio command against the allowlist pattern.
 * Rejects shell meta-characters.
 */
export const validateStdioCommand = (command: string): void => {
  if (!command.trim()) {
    throw new Error('Command is required')
  }
  if (!/^[a-zA-Z0-9._/-]+$/.test(command)) {
    throw new Error('Command contains invalid characters')
  }
}

/**
 * Validates stdio args array for injection safety.
 * Rejects args containing null bytes.
 */
export const validateStdioArgs = (args: string[]): void => {
  for (const arg of args) {
    if (arg.includes('\0')) {
      throw new Error('Arguments must not contain null bytes')
    }
  }
}

/**
 * Validates an MCP server URL for security and platform support.
 * Blocks plain HTTP to non-localhost addresses (insecure over the network).
 */
export const validateMcpServerUrl = (url: string): { valid: boolean; error?: string } => {
  try {
    const parsed = new URL(url)
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      return { valid: false, error: 'URL must use http: or https: protocol' }
    }
    if (parsed.protocol === 'http:' && !isLocalMcpServer(url)) {
      return {
        valid: false,
        error: 'Plain HTTP is only supported for localhost servers. Use HTTPS for remote servers.',
      }
    }
    return { valid: true }
  } catch {
    return { valid: false, error: 'Invalid URL format' }
  }
}

/** Returns true when an MCP server URL targets localhost/loopback (no CORS proxy needed) */
export const isLocalMcpServer = (url: string): boolean => {
  try {
    const hostname = new URL(url).hostname.toLowerCase()
    return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1'
  } catch {
    return false
  }
}
