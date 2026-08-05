/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * `thunderbolt login`: authenticate the CLI against the account with the RFC 8628
 * device grant, or short-circuit via a `THUNDERBOLT_TOKEN` PAT for CI / self-host.
 *
 * {@link performLogin} is the DI'd core (transport / clock / storage / output all
 * injected) so the flow is unit-testable without real network or timers;
 * {@link runLogin} is the thin wiring that binds the real implementations.
 */

import { authBaseUrl, isSecureCloudUrl, resolveCloudUrl, resolvePatToken } from './config.ts'
import { pollForToken, systemClock, type Clock, type DeviceGrantTransport } from './device-grant.ts'
import { createHttpTransport } from './http-transport.ts'
import { renderTerminalQr, shouldRenderQr, type QrEnv } from './qr.ts'
import { storeAuthConfig, type CliAuthConfig } from './token-store.ts'

/** Resolved environment inputs for a login: which backend, and an optional PAT. */
export type LoginEnv = {
  readonly cloudUrl: string
  readonly patToken?: string
}

/** Everything {@link performLogin} needs, injected so the flow has no ambient I/O. */
export type LoginDeps = {
  readonly env: LoginEnv
  readonly transport: DeviceGrantTransport
  readonly clock: Clock
  readonly storeToken: (config: CliAuthConfig) => Promise<void>
  readonly print: (line: string) => void
  readonly renderQr: (text: string) => void
  readonly qrEnv: QrEnv
}

/**
 * Run the login flow with all dependencies injected. When a PAT is present it is
 * used directly and nothing else runs; otherwise it requests device+user codes,
 * shows the link (+ best-effort QR), polls until approval, and persists the token.
 *
 * @param deps - injected transport, clock, storage, output, and QR sink
 * @returns the resolved bearer token
 */
export const performLogin = async (deps: LoginDeps): Promise<string> => {
  if (deps.env.patToken) {
    deps.print('Using THUNDERBOLT_TOKEN from the environment; skipping interactive login.')
    return deps.env.patToken
  }

  // The device grant transmits a replayable bearer to this host, so refuse plain
  // HTTP to anything but loopback rather than leak it over cleartext.
  if (!isSecureCloudUrl(deps.env.cloudUrl)) {
    throw new Error(
      `refusing to log in over insecure transport: ${deps.env.cloudUrl}. Use an https:// URL (plain http is allowed only for localhost).`,
    )
  }

  const code = await deps.transport.requestCode()
  deps.print(`\nTo authorize this CLI, open:\n  ${code.verificationUri}\nand enter the code:  ${code.userCode}\n`)
  if (shouldRenderQr(deps.qrEnv)) deps.renderQr(code.verificationUriComplete)

  deps.print('Waiting for approval…')
  const token = await pollForToken(code, deps.transport, deps.clock)
  await deps.storeToken({ token, cloudUrl: deps.env.cloudUrl })

  deps.print('Login successful. Credentials saved.')
  return token
}

/**
 * Entry point for the `login` subcommand: binds the real transport, clock,
 * storage, and terminal, then runs {@link performLogin}.
 */
export const runLogin = async (): Promise<void> => {
  const cloudUrl = resolveCloudUrl()
  await performLogin({
    env: { cloudUrl, patToken: resolvePatToken() },
    transport: createHttpTransport(authBaseUrl(cloudUrl)),
    clock: systemClock,
    storeToken: storeAuthConfig,
    print: (line) => console.log(line),
    renderQr: (text) => renderTerminalQr(text),
    qrEnv: { isTty: Boolean(process.stdout.isTTY), columns: process.stdout.columns ?? 0 },
  })
}
