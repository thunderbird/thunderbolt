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
  if (!command.trim()) throw new Error('Command is required')
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
