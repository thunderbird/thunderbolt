/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { p256 } from '@noble/curves/nist.js'
import { ml_kem768 } from '@noble/post-quantum/ml-kem.js'
import { entropyToMnemonic, mnemonicToEntropy } from '@scure/bip39'
import { wordlist } from '@scure/bip39/wordlists/english.js'

const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

const fromBase64 = (value: string): Uint8Array => {
  const clean = value.replace(/=+$/, '')
  const out = new Uint8Array(Math.floor((clean.length * 6) / 8))
  let bits = 0
  let buffer = 0
  let offset = 0
  for (const char of clean) {
    const digit = alphabet.indexOf(char)
    if (digit < 0) throw new Error('Invalid base64')
    buffer = (buffer << 6) | digit
    bits += 6
    if (bits >= 8) {
      bits -= 8
      out[offset++] = (buffer >> bits) & 0xff
    }
  }
  return out
}

const toBase64 = (bytes: Uint8Array): string => {
  let result = ''
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i]
    const b = bytes[i + 1]
    const c = bytes[i + 2]
    result += alphabet[a >> 2]
    result += alphabet[((a & 3) << 4) | ((b ?? 0) >> 4)]
    result += b === undefined ? '=' : alphabet[((b & 15) << 2) | ((c ?? 0) >> 6)]
    result += c === undefined ? '=' : alphabet[c & 63]
  }
  return result
}

globalThis.__thunderboltNoble = {
  keygen: (seed: string) => {
    const pair = ml_kem768.keygen(fromBase64(seed))
    return JSON.stringify({ publicKey: toBase64(pair.publicKey), secretKey: toBase64(pair.secretKey) })
  },
  encapsulate: (publicKey: string, randomness: string) => {
    const result = ml_kem768.encapsulate(fromBase64(publicKey), fromBase64(randomness))
    return JSON.stringify({ ciphertext: toBase64(result.cipherText), sharedSecret: toBase64(result.sharedSecret) })
  },
  decapsulate: (ciphertext: string, secretKey: string) =>
    toBase64(ml_kem768.decapsulate(fromBase64(ciphertext), fromBase64(secretKey))),
  validatePublicKey: (publicKey: string) => {
    ml_kem768.encapsulate(fromBase64(publicKey), new Uint8Array(32))
    return 'valid'
  },
  p256Scalar: (seed: string) => toBase64(p256.utils.randomSecretKey(fromBase64(seed))),
  mnemonicEncode: (entropy: string) => entropyToMnemonic(fromBase64(entropy), wordlist),
  mnemonicDecode: (phrase: string) => toBase64(mnemonicToEntropy(phrase, wordlist)),
}
