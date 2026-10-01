/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Thin JS bindings for the passkey plugin. These speak the plugin's *decomposed*
// (already byte-decoded) shape — the WebAuthn-JSON ⇄ decomposed mapping lives in
// the app (src/lib/passkey-native.ts), where the WebAuthn contract and the
// @simplewebauthn types already live.

import { invoke } from '@tauri-apps/api/core'

export type RegisterRequest = {
  rpId: string
  challenge: number[]
  userId: number[]
  userName: string
  userDisplayName: string
  prfSalt?: number[]
}

export type AuthenticateRequest = {
  rpId: string
  challenge: number[]
  allowCredentials?: number[][]
  prfSalt?: number[]
}

/** base64url strings, ready to drop into a WebAuthn RegistrationResponseJSON. */
export type RegistrationResult = {
  id: string
  rawId: string
  clientDataJson: string
  attestationObject: string
  prfOutput: string
}

/** base64url strings, ready to drop into a WebAuthn AuthenticationResponseJSON. */
export type AssertionResult = {
  id: string
  rawId: string
  clientDataJson: string
  authenticatorData: string
  signature: string
  userHandle: string
  prfOutput: string
}

export const register = (request: RegisterRequest): Promise<RegistrationResult> =>
  invoke('plugin:passkey|register', { request })

export const authenticate = (request: AuthenticateRequest): Promise<AssertionResult> =>
  invoke('plugin:passkey|authenticate', { request })

export const isAvailable = (): Promise<boolean> => invoke('plugin:passkey|is_available')
