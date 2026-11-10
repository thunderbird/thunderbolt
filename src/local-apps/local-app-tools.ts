/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { tool, type Tool } from 'ai'
import { z } from 'zod'
import type { LocalApp, LocalAppOwner } from '@shared/local-app-protocol'
import type { PageDefinition } from '@shared/page-protocol'
import { localAppController } from './local-app-controller'

export type LocalAppToolOptions = {
  owner: LocalAppOwner
  cwd: string
  onOpen: (page: PageDefinition) => unknown | Promise<unknown>
}

export type LocalAppToolController = Pick<
  typeof localAppController,
  'create' | 'list' | 'get' | 'start' | 'status' | 'stop' | 'restart'
>

const localAppSchema = z.object({
  action: z.enum(['list', 'create', 'start', 'status', 'stop', 'restart']),
  appId: z.string().min(1).max(128).optional().describe('Existing local app id; required except for list/create.'),
  title: z.string().trim().min(1).max(200).optional().describe('Human-readable title, required for create.'),
  executable: z
    .string()
    .min(1)
    .max(8192)
    .optional()
    .describe(
      'Executable such as bun, node, or python3. Prefer an absolute path obtained with the coding shell (command -v) because a desktop app may have a different PATH. Required for create; no shell expansion.',
    ),
  args: z
    .array(z.string().max(32768))
    .max(100)
    .optional()
    .describe(
      'Executable arguments. Use {port} for the allocated loopback port, and explicitly bind the server to 127.0.0.1.',
    ),
  port: z
    .number()
    .int()
    .min(1)
    .max(65535)
    .optional()
    .describe(
      'Only for programs requiring a fixed port. Otherwise use {port} in args or read PORT from the environment.',
    ),
})

/** A stable local source resolves a fresh server URL each time the app launches. */
export const localAppPage = (app: LocalApp): PageDefinition => ({
  id: `local-app:${app.id}`,
  title: app.title,
  source: { kind: 'local-app', appId: app.id, ...(app.owner.kind === 'project' ? { projectId: app.owner.id } : {}) },
})

/** Bind launch tools to this environment so a chat cannot operate another project's local app. */
export const createLocalAppTools = (
  options: LocalAppToolOptions,
  controller: LocalAppToolController = localAppController,
): Record<string, Tool> => {
  const permitted = (app: LocalApp) =>
    app.owner.kind === options.owner.kind && app.owner.id === options.owner.id && app.cwd === options.cwd
  const requireApp = (id?: string) => {
    if (!id) {
      throw new Error('Provide appId from local_app list or create')
    }
    const app = controller.get(id)
    if (!app || !permitted(app)) {
      throw new Error('This local app does not belong to the current environment')
    }
    return app
  }
  return {
    local_app: tool({
      description:
        'Create, start, inspect, restart, or stop a persistent app running on this computer. First create its files with the coding tools in the current working directory. Create saves a device-local launch recipe, starts the server, waits for HTTP readiness, and opens its page in the browser. Start/restart also open the page. Processes survive agent turns and stop on app exit or explicit stop. Use this instead of backgrounding a server with bash. Files and launch recipes do not sync. The working directory is fixed to the current project or standalone chat environment.',
      inputSchema: localAppSchema,
      execute: async (raw, { abortSignal }) => {
        const input = localAppSchema.parse(raw)
        abortSignal?.throwIfAborted()
        if (input.action === 'list') {
          return {
            apps: controller
              .list(options.owner)
              .filter(permitted)
              .map((app) => ({ id: app.id, title: app.title, page: localAppPage(app) })),
          }
        }
        if (input.action === 'create') {
          if (!input.title || !input.executable) {
            throw new Error('Provide title and executable for create')
          }
          const app = controller.create({
            owner: options.owner,
            cwd: options.cwd,
            title: input.title,
            launch: {
              executable: input.executable,
              args: input.args ?? [],
              ...(input.port === undefined ? {} : { port: input.port }),
            },
          })
          try {
            const status = await controller.start(app.id, abortSignal)
            const page = localAppPage(app)
            await options.onOpen(page)
            return { appId: app.id, page, status: status.status }
          } catch (error) {
            throw new Error(
              `Local app ${app.id} could not open: ${error instanceof Error ? error.message : String(error)}. Inspect it with local_app status before retrying.`,
              { cause: error },
            )
          }
        }
        const app = requireApp(input.appId)
        if (input.action === 'status') {
          return { appId: app.id, status: await controller.status(app.id) }
        }
        if (input.action === 'stop') {
          return { appId: app.id, status: await controller.stop(app.id) }
        }
        const status = await (input.action === 'restart'
          ? controller.restart(app.id, abortSignal)
          : controller.start(app.id, abortSignal))
        const page = localAppPage(app)
        await options.onOpen(page)
        return { appId: app.id, page, status: status.status }
      },
    }),
  }
}
