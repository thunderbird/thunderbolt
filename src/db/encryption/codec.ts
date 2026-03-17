import { encodeIfNotBase64, decodeIfBase64 } from '@/lib/base64'

export type EncryptionCodec = {
  encode: (plaintext: string) => string
  decode: (ciphertext: string) => string
}

/** Base64 codec (PoC). Replace internals with AES-GCM when ready. */
export const codec: EncryptionCodec = {
  encode: encodeIfNotBase64,
  decode: decodeIfBase64,
}
