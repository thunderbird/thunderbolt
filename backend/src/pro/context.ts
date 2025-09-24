/**
 * Simple context for operations (logging removed to keep business logic clean)
 */
export class SimpleContext {
  /**
   * Info method - no longer logs to keep business logic clean
   */
  async info(message: string): Promise<void> {
    // Business logic logging removed - HTTP logging handled by middleware
  }

  /**
   * Error method - no longer logs to keep business logic clean  
   */
  async error(message: string): Promise<void> {
    // Business logic logging removed - HTTP logging handled by middleware
  }
}
