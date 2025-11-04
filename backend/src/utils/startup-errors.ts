import { ZodError } from 'zod'

/**
 * Enhanced error type for startup failures
 */
class StartupError extends Error {
  constructor(
    message: string,
    public readonly originalError?: unknown,
  ) {
    super(message)
    this.name = 'StartupError'
  }
}

/**
 * Extract error message from unknown error type
 */
const getErrorMessage = (error: unknown): string => {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Format Zod validation errors into readable messages
 */
const formatZodError = (error: ZodError): string => {
  const issues = error.issues.map((issue) => {
    const path = issue.path.join('.')
    return `  - ${path}: ${issue.message}`
  })
  return `\n${issues.join('\n')}`
}

/**
 * Wraps settings validation with enhanced error context
 */
export const withSettingsValidation = <T>(fn: () => T): T => {
  try {
    return fn()
  } catch (error) {
    if (error instanceof ZodError) {
      throw new StartupError(`Failed to validate server settings${formatZodError(error)}`, error)
    }

    throw new StartupError(`Failed to load server settings: ${getErrorMessage(error)}`, error)
  }
}

/**
 * Wraps app creation with enhanced error context
 */
export const withAppCreation = async <T>(fn: () => Promise<T>): Promise<T> => {
  try {
    return await fn()
  } catch (error) {
    throw new StartupError(`Failed to initialize application: ${getErrorMessage(error)}`, error)
  }
}

/**
 * Generate a helpful error message for server listen failures
 */
const getServerListenErrorMessage = (error: unknown, hostname: string, port: number): string => {
  if (!(error instanceof Error)) {
    return `Failed to start server on ${hostname}:${port}: ${String(error)}`
  }

  const baseMessage = `Failed to start server on ${hostname}:${port}`
  const errorMsg = error.message.toLowerCase()

  if (errorMsg.includes('eaddrinuse') || errorMsg.includes('address already in use')) {
    return `${baseMessage}: Port ${port} is already in use. Check if another instance is running or change the PORT environment variable.`
  }

  if (errorMsg.includes('eacces') || errorMsg.includes('permission denied')) {
    return `${baseMessage}: Permission denied. Try using a port number above 1024 or run with appropriate permissions.`
  }

  if (errorMsg.includes('eaddrnotavail')) {
    return `${baseMessage}: Address not available. Check if the hostname '${hostname}' is valid.`
  }

  return `${baseMessage}: ${error.message}`
}

/**
 * Wraps server listen with enhanced error context
 */
export const withServerListen = async <T>(fn: () => Promise<T>, port: number, hostname: string): Promise<T> => {
  try {
    return await fn()
  } catch (error) {
    throw new StartupError(getServerListenErrorMessage(error, hostname, port), error)
  }
}
