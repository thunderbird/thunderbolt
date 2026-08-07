/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Which account models a deploy can target, and how a deployed sandbox dials
 * them. Shared by the frontend (builds the connection from the selected model)
 * and the backend (re-validates it per provider).
 *
 * Deployable providers:
 *  - `thunderbolt` (managed): backend mints a scoped token and points the
 *    sandbox at our inference endpoint.
 *  - fixed BYOK (`openai` / `openrouter` / `anthropic`): known base URL + wire
 *    compatibility; the sandbox dials the provider directly with the user's key.
 *  - `custom` (BYOK): base URL derives from the model's own `url`, always
 *    `openai` compatibility.
 *
 * Never deployable:
 *  - `tinfoil`: served through an HPKE enclave with no plain base URL, so a
 *    cloud sandbox cannot dial it.
 *  - loopback `custom` URLs (LM Studio / Ollama on `localhost` / `127.*` / `::1`):
 *    reachable only from the user's own machine, never from the sandbox.
 */

/** The managed provider whose models the backend serves via a minted token. */
export const managedProvider = 'thunderbolt' as const

/**
 * BYOK providers with a fixed base URL + wire compatibility. `custom` is also
 * BYOK-deployable but derives its base URL from the model's own `url` and always
 * uses `openai` compatibility, so it is not listed here.
 */
export const byokProviderConfig = {
  openai: { baseUrl: 'https://api.openai.com/v1', compatibility: 'openai' },
  openrouter: { baseUrl: 'https://openrouter.ai/api/v1', compatibility: 'openai' },
  anthropic: { baseUrl: 'https://api.anthropic.com', compatibility: 'anthropic' },
} as const

/** Whether `provider` is the Thunderbolt-managed provider (token minted server-side). */
export const isManagedProvider = (provider: string): boolean => provider === managedProvider

/** Whether `provider` is a BYOK provider with a fixed base URL (see {@link byokProviderConfig}). */
export const isFixedByokProvider = (provider: string): provider is keyof typeof byokProviderConfig =>
  provider in byokProviderConfig
