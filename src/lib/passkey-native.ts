/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { getPlatform } from '@/lib/platform'
import { invoke } from '@tauri-apps/api/core'
import { version } from '@tauri-apps/plugin-os'
import type {
  AuthenticationResponseJSON,
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
  RegistrationResponseJSON,
} from '@simplewebauthn/browser'

/**
 * Native passkey ceremonies for the Apple Tauri apps. WKWebView has no
 * `navigator.credentials`, so `tauri-plugin-passkey` runs the ceremony natively.
 * This maps the server's WebAuthn options to the plugin's byte-level request and
 * rebuilds the standard response JSON, so server verification is the same as web.
 */

/**
 * The only RP ID the Apple apps can use: their `webcredentials` associated domain
 * (src-tauri/Entitlements.plist and the iOS entitlements). The OS refuses any other.
 */
export const nativePasskeyRpId = 'app.thunderbolt.io'

/** How the plugin rejects (its `Error`, src-tauri/plugins/tauri-plugin-passkey/src/error.rs). */
type NativePasskeyError = { code: 'cancelled' | 'failed' | 'unavailable'; message: string }

/** Whether a rejection is the plugin's own `{ code, message }` error. */
const isNativePasskeyError = (error: unknown): error is NativePasskeyError =>
  typeof error === 'object' && error !== null && 'code' in error && 'message' in error

/**
 * Run a plugin ceremony. Rejections become `Error`s, and a dismissed sheet the
 * same `NotAllowedError` a browser ceremony throws, so callers check one shape.
 */
const invokePasskey = async <T>(command: 'register' | 'authenticate', request: Record<string, unknown>) => {
  try {
    return await invoke<T>(`plugin:passkey|${command}`, { request })
  } catch (error) {
    // Tauri's own failures (ACL, deserialization) reject with a plain string.
    if (!isNativePasskeyError(error)) {
      throw new Error(String(error), { cause: error })
    }
    throw Object.assign(new Error(error.message), { name: error.code === 'cancelled' ? 'NotAllowedError' : 'Error' })
  }
}

/** The first OS versions with platform passkeys; the apps themselves support older ones. */
const minimumPasskeyVersion = { ios: 16, macos: 13 }

/** True on the Tauri platforms with a native passkey bridge. */
export const isNativePasskeyPlatform = (): boolean => {
  const platform = getPlatform()
  if (platform !== 'ios' && platform !== 'macos') {
    return false
  }
  return Number.parseInt(version(), 10) >= minimumPasskeyVersion[platform]
}

/** Decode a base64url string, with or without padding, into byte values. */
const base64UrlToBytes = (value: string): number[] => {
  const padded = value
    .replace(/-/g, '+')
    .replace(/_/g, '/')
    .padEnd(Math.ceil(value.length / 4) * 4, '=')
  return Array.from(atob(padded), (char) => char.charCodeAt(0))
}

/** The plugin returns the PRF output as base64url, or empty when the provider has none. */
const readPrfOutput = (value: string): Uint8Array | null => (value ? new Uint8Array(base64UrlToBytes(value)) : null)

type NativeRegistration = {
  id: string
  rawId: string
  clientDataJson: string
  attestationObject: string
  prfOutput: string
}

type NativeAssertion = {
  id: string
  rawId: string
  clientDataJson: string
  authenticatorData: string
  signature: string
  userHandle: string
  prfOutput: string
}

/**
 * Create a passkey natively. An empty `prfSalt` leaves the PRF extension out.
 * The PRF output is returned separately and never put in the response.
 * `excludeCredentials` keeps a second passkey out of a keychain that has one.
 */
export const registerPasskeyNative = async (
  options: PublicKeyCredentialCreationOptionsJSON,
  prfSalt: Uint8Array,
): Promise<{ response: RegistrationResponseJSON; prfOutput: Uint8Array | null }> => {
  if (!options.rp.id) {
    throw new Error('A native passkey registration needs an RP ID')
  }
  const result = await invokePasskey<NativeRegistration>('register', {
    rpId: options.rp.id,
    challenge: base64UrlToBytes(options.challenge),
    userId: base64UrlToBytes(options.user.id),
    userName: options.user.name,
    excludeCredentials: (options.excludeCredentials ?? []).map((credential) => base64UrlToBytes(credential.id)),
    prfSalt: Array.from(prfSalt),
  })
  return {
    response: {
      id: result.id,
      rawId: result.rawId,
      type: 'public-key',
      response: {
        clientDataJSON: result.clientDataJson,
        attestationObject: result.attestationObject,
        // Better Auth stores `transports.join(',')`, so the field must be present.
        transports: [],
      },
      clientExtensionResults: {},
    },
    prfOutput: readPrfOutput(result.prfOutput),
  }
}

/**
 * Get a passkey assertion natively. The native API needs an explicit RP ID, so
 * `options.rpId` must be set. An empty `prfSalt` leaves the PRF extension out.
 */
export const authenticatePasskeyNative = async (
  options: PublicKeyCredentialRequestOptionsJSON,
  prfSalt: Uint8Array,
): Promise<{ response: AuthenticationResponseJSON; prfOutput: Uint8Array | null }> => {
  if (!options.rpId) {
    throw new Error('A native passkey assertion needs an RP ID')
  }
  const result = await invokePasskey<NativeAssertion>('authenticate', {
    rpId: options.rpId,
    challenge: base64UrlToBytes(options.challenge),
    allowCredentials: (options.allowCredentials ?? []).map((credential) => base64UrlToBytes(credential.id)),
    prfSalt: Array.from(prfSalt),
  })
  return {
    response: {
      id: result.id,
      rawId: result.rawId,
      type: 'public-key',
      response: {
        clientDataJSON: result.clientDataJson,
        authenticatorData: result.authenticatorData,
        signature: result.signature,
        userHandle: result.userHandle || undefined,
      },
      clientExtensionResults: {},
    },
    prfOutput: readPrfOutput(result.prfOutput),
  }
}
