/**
 * Normalizes an email address for consistent storage and comparison.
 * - Converts to lowercase
 * - Trims whitespace
 */
export const normalizeEmail = (email: string) => email.toLowerCase().trim()
