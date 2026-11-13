/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/// <reference types="vite/client" />

// eslint-disable-next-line @typescript-eslint/consistent-type-definitions
interface ImportMetaEnv {
  readonly VITE_THUNDERBOLT_CLOUD_URL?: string
  readonly VITE_THUNDERBOLT_CLOUD_SERVICE_URL?: string
  readonly VITE_TINFOIL_CLIENT_ID?: string
  readonly VITE_AUTH_MODE?: 'thunderbolt' | 'sso'
  readonly VITE_AUTH_ENABLE_ANONYMOUS?: 'true' | 'false'
  /** `altcha` solves a proof-of-work challenge before anonymous sign-in. Must match the API's CAPTCHA_PROVIDER. */
  readonly VITE_CAPTCHA_PROVIDER?: 'altcha'
  readonly VITE_APP_VERSION?: string
  readonly TAURI_ENV_DEBUG: boolean
  /** Operator key-escrow public key (THU-804): base64 raw uncompressed P-256 point. Unset = no escrow. */
  readonly VITE_ORG_ESCROW_PUBLIC_KEY?: string
  readonly VITE_GOOGLE_BASE_URL?: string
  readonly VITE_MICROSOFT_BASE_URL?: string
}

// .po catalogs are compiled to JS message objects by @lingui/vite-plugin.
declare module '*.po' {
  import type { Messages } from '@lingui/core'
  export const messages: Messages
}

// A module bundled into one classic script, as text (scripts/office-sandbox-script.ts).
declare module '*?sandbox-script' {
  const script: string
  export default script
}

// eslint-disable-next-line @typescript-eslint/consistent-type-definitions
interface ImportMeta {
  readonly env: ImportMetaEnv
}
