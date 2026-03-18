import { NotImplementedError } from './errors'
import type { EncryptedRecord } from './envelope'

export type RecipientEnvelope = {
  recipientUserId: string
  wrappedContentKey: string
}

export type SharedEncryptedRecord = EncryptedRecord & {
  recipientEnvelopes: RecipientEnvelope[]
}

/** Wraps a content key for one or more recipients using their public keys. Phase 3. */
export const encryptForRecipients = async (
  _contentKey: CryptoKey,
  _recipientPublicKeys: CryptoKey[],
): Promise<never> => {
  throw new NotImplementedError('encryptForRecipients is Phase 3')
}

/** Unwrap a recipient envelope using the current user's private key. Phase 3. */
export const decryptFromSender = async (
  _envelope: RecipientEnvelope,
  _privateKey: CryptoKey,
): Promise<never> => {
  throw new NotImplementedError('decryptFromSender is Phase 3')
}
