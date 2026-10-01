/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Native (Tauri) passkey adapter — THU-790, Apple platforms.
 *
 * WKWebView doesn't expose `navigator.credentials`, so on Tauri the ceremony runs
 * through the native `tauri-plugin-passkey` (iOS + macOS). This module is the
 * mirror of the browser path in `passkey.ts`: it maps the server's WebAuthn options
 * JSON to the plugin's decomposed (byte) request, invokes the native command, and
 * re-assembles a standard `RegistrationResponseJSON` / `AuthenticationResponseJSON`
 * so the rest of the flow (server verify, session) is identical to web.
 */

import { getPlatform } from '@/lib/platform'
import { invoke } from '@tauri-apps/api/core'
import type {
  AuthenticationResponseJSON,
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
  RegistrationResponseJSON,
} from '@simplewebauthn/browser'

/** True on the Tauri platforms with a native passkey bridge (Apple only for now). */
export const isNativePasskeyPlatform = (): boolean => {
  const platform = getPlatform()
  return platform === 'macos' || platform === 'ios'
}

const base64UrlToBytes = (value: string): number[] => {
  const padded = value
    .replace(/-/g, '+')
    .replace(/_/g, '/')
    .padEnd(Math.ceil(value.length / 4) * 4, '=')
  const binary = atob(padded)
  return Array.from(binary, (char) => char.charCodeAt(0))
}

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

/** Whether the native plugin reports passkeys usable on this OS/version. */
export const isNativePasskeyAvailable = (): Promise<boolean> => invoke('plugin:passkey|is_available')

// PRF is Phase B (E2EE unlock), not sign-in. The native plugin carries PRF
// end-to-end, but this sign-in adapter leaves the salt empty and ignores the
// output — TODO(THU-790 Phase B): thread `options.extensions.prf` once the
// WebAuthn PRF types land / the E2EE slot lands.

export const registerPasskeyNative = async (
  options: PublicKeyCredentialCreationOptionsJSON,
): Promise<RegistrationResponseJSON> => {
  const result = await invoke<NativeRegistration>('plugin:passkey|register', {
    request: {
      rpId: options.rp.id,
      challenge: base64UrlToBytes(options.challenge),
      userId: base64UrlToBytes(options.user.id),
      userName: options.user.name,
      userDisplayName: options.user.displayName,
      prfSalt: [],
    },
  })

  return {
    id: result.id,
    rawId: result.rawId,
    type: 'public-key',
    response: {
      clientDataJSON: result.clientDataJson,
      attestationObject: result.attestationObject,
      transports: [],
    },
    clientExtensionResults: {},
    authenticatorAttachment: 'platform',
  }
}

export const authenticatePasskeyNative = async (
  options: PublicKeyCredentialRequestOptionsJSON,
): Promise<AuthenticationResponseJSON> => {
  const result = await invoke<NativeAssertion>('plugin:passkey|authenticate', {
    request: {
      rpId: options.rpId,
      challenge: base64UrlToBytes(options.challenge),
      allowCredentials: (options.allowCredentials ?? []).map((credential) => base64UrlToBytes(credential.id)),
      prfSalt: [],
    },
  })

  return {
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
    authenticatorAttachment: 'platform',
  }
}
