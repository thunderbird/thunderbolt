// Re-export Better Auth schema tables
export * from './auth-schema'

// Re-export waitlist schema
export * from './waitlist-schema'

// Re-export PowerSync schema tables
export * from './powersync-schema'

// Re-export rate limit schema
export * from './rate-limit-schema'

// Re-export encryption schema tables (server-only, not synced via PowerSync)
export * from './encryption-schema'

// Re-export OTP challenge schema (session binding for OTP verification)
export * from './otp-challenge-schema'
