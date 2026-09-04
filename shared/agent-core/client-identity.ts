/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

export type ClientEnvironment = 'cli' | 'web' | 'desktop' | 'ios' | 'android'

/** Treat Bun's stringified undefined env assignment as a missing build version. */
export const normalizeClientAppVersion = (appVersion?: string): string | undefined =>
  appVersion && appVersion !== 'undefined' ? appVersion : undefined

/** Builds the client identity disclosed to an agent system prompt. */
export const buildClientIdentityBlock = ({
  environment,
  appVersion,
}: {
  environment: ClientEnvironment
  appVersion?: string
}): string => {
  const version = normalizeClientAppVersion(appVersion)
  return `Client environment: ${environment}${version ? `\nApp version: ${version}` : ''}`
}
