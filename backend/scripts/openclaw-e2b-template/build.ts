/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Build the `thunderbolt-openclaw` E2B template — the prebuilt image every
 * OpenClaw deploy boots from (see `backend/src/openclaw/e2b.ts`).
 *
 * Starts from the bare-OpenClaw template (reuses its node + openclaw install)
 * and layers what our stack adds: bun (runs the shim), the ACP↔WS shim, and the
 * headless entrypoint.
 *
 * Run from anywhere:  bun backend/scripts/openclaw-e2b-template/build.ts
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Template } from 'e2b'

const scriptDir = import.meta.dir

// E2B_API_KEY lives in backend/.env — the template lands in whatever account owns that key.
const envFile = readFileSync(join(scriptDir, '..', '..', '.env'), 'utf8')
const apiKey = envFile.match(/^E2B_API_KEY=(.+)$/m)?.[1]?.trim()
if (!apiKey) {
  throw new Error('E2B_API_KEY not found in backend/.env')
}
process.env.E2B_API_KEY = apiKey

const BASE_TEMPLATE = process.env.BASE_TEMPLATE ?? 'u2bzpic9lzyttv5jh36g'
const TEMPLATE_NAME = process.env.TEMPLATE_NAME ?? 'thunderbolt-openclaw'

// E2B `copy()` resolves sources relative to this script's dir, so the shim and
// entrypoint sit next to it.
const template = Template()
  .fromTemplate(BASE_TEMPLATE)
  // bun runs the shim; install to /usr/local so it's on PATH for the start user.
  .runCmd('command -v bun >/dev/null 2>&1 || (curl -fsSL https://bun.sh/install | BUN_INSTALL=/usr/local bash)')
  .copy('acp-ws-shim.ts', '/opt/shim/acp-ws-shim.ts')
  .copy('docker-entrypoint.sh', '/opt/docker-entrypoint.sh')
  .runCmd('chmod +x /opt/docker-entrypoint.sh')
  // NOTE: no setStartCmd — E2B validates the start command's readiness at BUILD
  // time, but the launch needs per-deployment inference env that only exists at
  // runtime. So `e2b.ts` runs its own launch script at deploy time via
  // commands.run (with those values in envs) and probes ACP readiness itself.

console.log(`building E2B template "${TEMPLATE_NAME}" from base ${BASE_TEMPLATE}…`)
const info = await Template.build(template, TEMPLATE_NAME, {
  onBuildLogs: (log: { message?: string }) => console.log(log.message ?? JSON.stringify(log)),
})
console.log('\n✅ built:', JSON.stringify(info))
