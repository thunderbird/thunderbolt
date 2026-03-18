import { NotImplementedError } from './errors'

/**
 * Register a passkey to protect the master key.
 * Runs the WebAuthn registration ceremony. Phase 3.
 */
export const registerPasskey = async (): Promise<never> => {
  throw new NotImplementedError('registerPasskey is Phase 3')
}

/**
 * Unlock the master key using a passkey.
 * Runs the WebAuthn authentication ceremony. Phase 3.
 */
export const unlockWithPasskey = async (): Promise<never> => {
  throw new NotImplementedError('unlockWithPasskey is Phase 3')
}

/**
 * Lock the session — clears the master key session cache.
 * Sets key state to KEY_LOCKED. Phase 3.
 */
export const lockSession = (): never => {
  throw new NotImplementedError('lockSession is Phase 3')
}
