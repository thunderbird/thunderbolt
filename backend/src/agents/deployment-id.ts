/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * A deployment id is `<provider>:<ref>` — self-describing so the deployment-status
 * endpoint can resolve the owning provider and poll the host directly, with no
 * server-side deployment table (THU-743). `provider` is the registry key (the
 * agent kind); `ref` is the host-scoped identifier (e.g. a Deepset pipeline name).
 */

const separator = ':'

/** Build a deployment id from a provider id and a host reference. */
export const encodeDeploymentId = (provider: string, ref: string): string => {
  if (!provider || provider.includes(separator)) {
    throw new Error(`invalid provider for deployment id: ${JSON.stringify(provider)}`)
  }
  if (!ref) {
    throw new Error('deployment id requires a non-empty ref')
  }
  return `${provider}${separator}${ref}`
}

/** Parse a deployment id back into its provider and ref. Splits on the first
 *  separator so a ref may itself contain `:`. */
export const decodeDeploymentId = (deploymentId: string): { provider: string; ref: string } => {
  const index = deploymentId.indexOf(separator)
  if (index <= 0 || index === deploymentId.length - 1) {
    throw new Error(`malformed deployment id: ${JSON.stringify(deploymentId)}`)
  }
  return { provider: deploymentId.slice(0, index), ref: deploymentId.slice(index + 1) }
}
