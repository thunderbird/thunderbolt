/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { fetch } from 'bun'
import { execFileSync } from 'node:child_process'

const image = 'nginxinc/nginx-unprivileged:alpine'
/** The DNS server every test container is given: an address reserved for documentation, where nothing answers. */
export const unreachableDns = '192.0.2.53'

/** Run a Docker command and return its trimmed output; a failing command throws. */
export const docker = (...args: string[]) => execFileSync('docker', args, { encoding: 'utf8' }).trim()

/**
 * Start the image both site containers are built on, with the given `docker run` options, and
 * wait until it answers. Its DNS server is unreachable on purpose: a config that needs to
 * resolve a name before nginx can start fails here instead of in production.
 *
 * @returns The origin the container is published on.
 */
export const startNginx = async (name: string, options: string[]) => {
  docker(
    'run',
    '--detach',
    '--rm',
    '--name',
    name,
    '--publish',
    '127.0.0.1::8080',
    '--dns',
    unreachableDns,
    '--env',
    'NGINX_ENTRYPOINT_LOCAL_RESOLVERS=1',
    ...options,
    image,
  )
  const origin = `http://${docker('port', name, '8080/tcp')}`
  // Startup readiness is bounded; errors from a test's own requests are never retried.
  const deadline = Date.now() + 10_000
  while (true) {
    try {
      await fetch(origin)
      return origin
    } catch (error) {
      if (Date.now() >= deadline) throw error
      await Bun.sleep(100)
    }
  }
}
