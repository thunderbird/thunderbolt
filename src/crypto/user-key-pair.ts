import { NotImplementedError } from './errors'

/** Generates an ECDH key pair for the user account. Phase 3. */
export const generateUserKeyPair = async (): Promise<never> => {
  throw new NotImplementedError('generateUserKeyPair is Phase 3')
}

/** Get the user's public key. Phase 3. */
export const getUserPublicKey = async (): Promise<never> => {
  throw new NotImplementedError('getUserPublicKey is Phase 3')
}

/** Get the user's private key. Phase 3. */
export const getUserPrivateKey = async (): Promise<never> => {
  throw new NotImplementedError('getUserPrivateKey is Phase 3')
}
