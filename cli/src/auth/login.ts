/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { toError } from '@earendil-works/pi-agent-core'
import type { CliAuth, DeviceGrantPresentation, SessionCredential } from '../provider-runtime/types.ts'
import { patRemainsActiveNote } from './config.ts'
import { pollForToken, type Clock, type DeviceGrantTransport } from './device-grant.ts'
import { renderTerminalQr, shouldRenderQr } from './qr.ts'
import { toAuth } from './token-store.ts'

type RegisteredCliAuth = Extract<CliAuth, { bearer: string }>

export type LoginDeps = {
  readonly patToken?: string
  readonly transport: DeviceGrantTransport
  readonly clock: Clock
  readonly presentation: DeviceGrantPresentation
  readonly ensureRegistered: (bearer: string) => Promise<SessionCredential>
  readonly createQrBlock: (verificationUrlComplete: string) => string | undefined
  readonly signal?: AbortSignal
}

/** Runs web device authorization and registers the resulting CLI installation. */
export const performLogin = async (deps: LoginDeps): Promise<RegisteredCliAuth> => {
  try {
    const code = await deps.transport.requestCode(deps.signal)
    deps.signal?.throwIfAborted()
    const qrBlock = deps.createQrBlock(code.verificationUriComplete)
    deps.presentation.showVerification({
      verificationUrl: code.verificationUri,
      userCode: code.userCode,
      qrBlock,
    })
    await deps.presentation.promptToOpenBrowser?.(code.verificationUriComplete)
    deps.presentation.showStatus('waiting', 'Waiting for approval…')

    const bearer = await pollForToken(code, deps.transport, deps.clock, deps.signal)
    const registered = await deps.ensureRegistered(bearer)
    deps.signal?.throwIfAborted()
    const message = deps.patToken ? `Login successful. ${patRemainsActiveNote}` : 'Login successful.'
    deps.presentation.showStatus('success', message)
    return toAuth(registered, 'registered') as RegisteredCliAuth
  } catch (error) {
    if (deps.signal?.aborted) throw error
    deps.presentation.showStatus('error', toError(error).message)
    throw error
  }
}

/** Produces a QR block only when the current terminal can display it legibly. */
export const createTerminalQrBlock = (text: string): string | undefined => {
  if (!shouldRenderQr({ isTty: Boolean(process.stdout.isTTY), columns: process.stdout.columns ?? 0 })) return undefined
  return renderTerminalQr(text)
}
