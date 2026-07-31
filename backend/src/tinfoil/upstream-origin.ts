/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

export type TinfoilUpstreamOriginStore = {
  get: () => string | null
  record: (upstreamUrl: string) => void
}

/** Create a store that retains only the latest Tinfoil upstream origin. */
export const createTinfoilUpstreamOriginStore = (): TinfoilUpstreamOriginStore => {
  const state: { latestOrigin: string | null } = { latestOrigin: null }

  return {
    get: () => state.latestOrigin,
    record: (upstreamUrl) => {
      state.latestOrigin = new URL(upstreamUrl).origin
    },
  }
}

export const tinfoilUpstreamOriginStore = createTinfoilUpstreamOriginStore()
