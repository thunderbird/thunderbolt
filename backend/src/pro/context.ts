/**
 * Simple context for logging and operations
 */
export class SimpleContext {
  /**
   * Log an info message
   */
  async info(message: string): Promise<void> {
    console.info(message)
  }

  /**
   * Log an error message
   */
  async error(message: string): Promise<void> {
    console.error(message)
  }
}
