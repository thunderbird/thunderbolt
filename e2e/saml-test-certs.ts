/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { execSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

/**
 * Generate a self-signed cert + key at runtime for the mock SAML IdP.
 * Avoids committing private keys to the repo (even test-only ones).
 *
 * Uses temp files instead of /dev/stdout for portability (CI runners
 * may not support writing to /dev/stdout from child processes).
 * Files are deleted immediately after reading.
 *
 * Cached so repeated imports within the same process return the same keypair.
 */
let cached: { privateKey: string; cert: string; certSingleLine: string } | null = null

const generate = () => {
  const dir = mkdtempSync(join(tmpdir(), 'saml-e2e-'))
  const keyPath = join(dir, 'key.pem')
  const certPath = join(dir, 'cert.pem')

  try {
    execSync(
      `openssl req -new -x509 -days 1 -nodes -sha256 -subj "/CN=E2E Mock SAML IdP" -keyout "${keyPath}" -out "${certPath}"`,
      { stdio: 'pipe' },
    )

    const privateKey = readFileSync(keyPath, 'utf-8')
    const cert = readFileSync(certPath, 'utf-8')
    const certSingleLine = cert.replace(/-----BEGIN CERTIFICATE-----|-----END CERTIFICATE-----|\n/g, '').trim()

    return { privateKey, cert, certSingleLine }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

export const getTestCerts = () => {
  if (!cached) {
    cached = generate()
  }
  return cached
}

/** Single-line base64 cert (no PEM headers) for passing as env var */
export const idpCertSingleLine = getTestCerts().certSingleLine
