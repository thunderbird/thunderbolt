/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { HttpError } from '@/lib/http'

/** Retain one encrypted request until acknowledged; a retry cannot mint a second resource or revision. */
export const createPreparedCloudRequest = <Command>() => {
  const state: { command?: Command } = {}
  return {
    pending: () => state.command !== undefined,
    run: async <Variables, Result>(
      variables: Variables,
      prepare: (variables: Variables) => Command | Promise<Command>,
      submit: (command: Command) => Promise<Result>,
    ): Promise<Result> => {
      state.command ??= await prepare(variables)
      try {
        const result = await submit(state.command)
        state.command = undefined
        return result
      } catch (error) {
        const rejected =
          error instanceof HttpError
            ? error
            : error instanceof Error && error.cause instanceof HttpError
              ? error.cause
              : null
        if (
          rejected &&
          rejected.response.status >= 400 &&
          rejected.response.status < 500 &&
          ![408, 409, 429].includes(rejected.response.status)
        ) {
          state.command = undefined
        }
        throw error
      }
    },
  }
}
