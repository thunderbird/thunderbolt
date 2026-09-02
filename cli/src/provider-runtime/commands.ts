/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { CommandOutcome, ProviderManagerMode, ProviderManagerRunner } from './types.ts'

type RoutedSlashCommand = {
  readonly name: string
  readonly description: string
  readonly mode: ProviderManagerMode | 'permissions'
}

/** Reserved commands shared by routing and interactive autocomplete. */
export const slashCommands = [
  { name: 'providers', description: 'Manage provider profiles', mode: 'providers' },
  { name: 'models', description: 'Choose the active model', mode: 'models' },
  { name: 'login', description: 'Sign in to Thunderbolt', mode: 'login' },
  { name: 'logout', description: 'Sign out of Thunderbolt', mode: 'logout' },
  { name: 'permissions', description: 'Choose the permission mode', mode: 'permissions' },
] satisfies RoutedSlashCommand[]

/** Identifies state reconciliation that must complete even when cancellation raced with its response. */
export const mustApplyAfterCancellation = (outcome: CommandOutcome): boolean => outcome.kind === 'deactivate'

/** Creates the shared pure text router for provider commands and agent input. */
export const createCommandRouter = (
  manager: ProviderManagerRunner,
  permissions: () => Promise<CommandOutcome>,
) => ({
  handle: async (text: string): Promise<CommandOutcome> => {
    const command = slashCommands.find(({ name }) => text === `/${name}`)
    if (command?.mode === 'permissions') return permissions()
    if (command) return manager(command.mode)
    if (text === 'exit' || text === 'quit') return { kind: 'exit' }
    return { kind: 'forward', text }
  },
})
