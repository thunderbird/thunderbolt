/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * A P-256 keypair for the org KMS escrow POC, generated at runtime and never
 * committed — the same convention as `e2e/saml-test-certs.ts`, except that this
 * one is cached in a file rather than in-process (see below), so a private key
 * does sit in `tmpdir` until the OS clears it. The path is per-run
 * (`COMPOSE_PROJECT_NAME` ends in the launcher's PID), so runs never share a key,
 * and the file is written 0600.
 *
 * Both `playwright.e2ee.config.ts` (which needs the public half to set
 * `ORG_KMS_ESCROW_STATIC_PUBLIC_KEY` before the backend boots) and
 * `org-escrow.spec.ts` (which needs the private half to drive
 * `scripts/kms-escrow-decrypt.ts`) call `getOrgKmsTestKeypair()`. Playwright
 * loads config files and test files in separate processes, so a plain
 * module-level constant would NOT be shared between them — this caches the
 * keypair to a temp file instead: whichever process calls first generates and
 * atomically claims it (`wx` — fails if the file already exists), every other
 * caller just reads the winner's file. `COMPOSE_PROJECT_NAME` (set by
 * scripts/run-e2ee-powersync.sh before either process starts, so it's
 * inherited by both via normal OS env propagation) scopes the path so
 * concurrent harness runs on the same machine don't collide.
 */

import { generateKeyPairSync } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

type OrgKmsTestKeypair = {
  publicKeyBase64: string
  privateKeyBase64: string
}

const keypairPath = join(
  tmpdir(),
  `thunderbolt-e2ee-org-kms-test-keypair-${process.env.COMPOSE_PROJECT_NAME ?? 'default'}.json`,
)

const generateKeypair = (): OrgKmsTestKeypair => {
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
  const jwk = publicKey.export({ format: 'jwk' }) as { x: string; y: string }
  const rawPoint = Buffer.concat([
    Buffer.from([0x04]),
    Buffer.from(jwk.x, 'base64url'),
    Buffer.from(jwk.y, 'base64url'),
  ])
  const pkcs8PrivateKey = privateKey.export({ format: 'der', type: 'pkcs8' })
  return { publicKeyBase64: rawPoint.toString('base64'), privateKeyBase64: pkcs8PrivateKey.toString('base64') }
}

export const getOrgKmsTestKeypair = (): OrgKmsTestKeypair => {
  // Read first: only the process that finds no file needs to mint a key, so the
  // adopters skip an EC keygen they would immediately throw away.
  try {
    return JSON.parse(readFileSync(keypairPath, 'utf8')) as OrgKmsTestKeypair
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw err
    }
  }

  const keypair = generateKeypair()
  try {
    // `wx` is the atomic claim: exactly one process creates the file, everyone
    // else adopts what it wrote.
    writeFileSync(keypairPath, JSON.stringify(keypair), { flag: 'wx', mode: 0o600 })
    return keypair
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
      return JSON.parse(readFileSync(keypairPath, 'utf8')) as OrgKmsTestKeypair
    }
    throw err
  }
}
