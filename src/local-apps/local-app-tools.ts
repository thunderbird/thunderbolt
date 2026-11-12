/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { tool, type Tool } from 'ai'
import { z } from 'zod'
import type { LocalApp, LocalAppOwner } from '@shared/local-app-protocol'
import type { PageDefinition } from '@shared/page-protocol'
import { isCurrentSshConnection, matchesSshConnection } from '@/agent-execution/ssh-environments'
import { localAppController } from './local-app-controller'

export type LocalAppToolOptions = {
  owner: LocalAppOwner
  cwd: string
  connection?: LocalApp['connection']
  onOpen: (page: PageDefinition) => string | Promise<string>
}

export type LocalAppToolController = Pick<
  typeof localAppController,
  'create' | 'list' | 'get' | 'start' | 'status' | 'stop' | 'restart' | 'update'
>

const localAppSchema = z.object({
  action: z.enum(['list', 'create', 'attach', 'start', 'status', 'stop', 'restart', 'update']),
  appId: z.string().min(1).max(128).optional().describe('Existing app id; required except for list/create/attach.'),
  title: z.string().trim().min(1).max(200).optional().describe('Human-readable title, required for create/attach.'),
  executable: z
    .string()
    .min(1)
    .max(4096)
    .optional()
    .describe(
      'Executable such as bun, node, or python3. Prefer an absolute path obtained with the coding shell (command -v) because a desktop app may have a different PATH. Required for create; optional replacement for update. No shell expansion.',
    ),
  args: z
    .array(z.string().max(32768))
    .max(100)
    .optional()
    .describe(
      'Executable arguments; replaces the full argument list on update. Use {port} for the allocated loopback port, and explicitly bind the server to 127.0.0.1.',
    ),
  port: z
    .number()
    .int()
    .min(1)
    .max(65535)
    .nullable()
    .optional()
    .describe(
      'Required remote port for attach. For create, only needed for programs requiring a fixed port; otherwise use {port} in args or read PORT from the environment. On SSH this is the remote port, not the forwarded desktop port. Omit to keep it on update; null returns launch recipes to an allocated port.',
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
    app.owner.kind === options.owner.kind &&
    app.owner.id === options.owner.id &&
    app.cwd === options.cwd &&
    matchesSshConnection(app.connection, options.connection)
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
  const open = (page: PageDefinition, signal?: AbortSignal) => {
    signal?.throwIfAborted()
    if (options.connection && !isCurrentSshConnection(options.connection)) {
      throw new Error('The SSH environment changed or was removed')
    }
    return options.onOpen(page)
  }
  return {
    local_app: tool({
      description:
        'Create, attach, update, start, inspect, restart, or stop a persistent app in the current computer or SSH environment. First create files with the coding tools in the current working directory. Create saves a device-local launch recipe, starts the server, waits for HTTP readiness, and opens its page in the desktop browser. SSH servers stay remote; Thunderbolt forwards their loopback port to this computer automatically. For an already-running SSH service use attach with title and its remote port; it opens a managed tunnel without starting or stopping that service. Start/restart also open the page. To fix a launch command, use update with its existing appId and changed executable/args/port; this preserves tabs and pins. Attached services can update only their remote port. Use returned sessionId, not page.id, for page_snapshot and page interaction tools. Managed processes and tunnels survive agent turns and stop on app exit or explicit stop. Use this instead of backgrounding a server with bash. Recipes do not sync; SSH files remain remote. The destination and working directory are fixed to this project or standalone chat environment.',
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
        if (input.action === 'create' || input.action === 'attach') {
          const attaching = input.action === 'attach'
          if (attaching && (!options.connection || !input.title || input.port == null)) {
            throw new Error('Attach requires an SSH environment, title and remote port')
          }
          if (attaching && (input.executable !== undefined || input.args !== undefined)) {
            throw new Error('Attach opens an existing service; use create to launch a command')
          }
          if (!attaching && (!input.title || !input.executable)) {
            throw new Error('Provide title and executable for create')
          }
          const app = controller.create({
            owner: options.owner,
            cwd: options.cwd,
            title: input.title!,
            ...(options.connection ? { connection: options.connection } : {}),
            launch: attaching
              ? { mode: 'attach', port: input.port! }
              : {
                  executable: input.executable!,
                  args: input.args ?? [],
                  ...(input.port == null ? {} : { port: input.port }),
                },
          })
          try {
            const status = await controller.start(app.id, abortSignal)
            abortSignal?.throwIfAborted()
            const page = localAppPage(app)
            const sessionId = await open(page, abortSignal)
            return { appId: app.id, page, sessionId, status: status.status }
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
        const status = await (input.action === 'update'
          ? controller.update(app.id, { executable: input.executable, args: input.args, port: input.port }, abortSignal)
          : input.action === 'restart'
            ? controller.restart(app.id, abortSignal)
            : controller.start(app.id, abortSignal))
        const page = localAppPage(app)
        abortSignal?.throwIfAborted()
        const sessionId = await open(page, abortSignal)
        return {
          appId: app.id,
          page,
          sessionId,
          status: status.status,
          ...(input.action === 'update' ? { updated: true } : {}),
        }
      },
    }),
  }
}
