/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

type TestApp = { handle: (request: Request) => Promise<Response> }

type CliRegistrationOptions = {
  name?: string
  appVersion?: string | null
  apiPrefix?: string
}

/** Send a CLI device-registration request through a test app. */
export const registerCliDevice = (
  app: TestApp,
  signedToken: string,
  deviceId: string,
  options: CliRegistrationOptions = {},
): Promise<Response> => {
  const headers = new Headers({
    Authorization: `Bearer ${signedToken}`,
    'X-Device-ID': deviceId,
    'X-Device-Name': options.name ?? 'Thunderbolt CLI',
  })
  const appVersion = options.appVersion === undefined ? '1.0.0-test' : options.appVersion
  if (appVersion !== null) {
    headers.set('X-App-Version', appVersion)
  }
  return app.handle(
    new Request(`http://localhost${options.apiPrefix ?? '/v1'}/account/devices/cli`, {
      method: 'PUT',
      headers,
    }),
  )
}
