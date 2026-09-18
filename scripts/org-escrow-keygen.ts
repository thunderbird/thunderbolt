#!/usr/bin/env bun

/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Org Escrow Keygen (THU-804 POC)
 *
 * Generates the operator-held P-256 escrow keypair for enterprise key escrow.
 * The PUBLIC half is the escrow PIN: it goes into the CLIENT build as
 * `VITE_ORG_ESCROW_PUBLIC_KEY`, not onto the app server (THU-866 — a server that
 * could choose the wrap target could escrow every account to itself). The
 * PRIVATE half must be stored OFFLINE by the operator and is consumed only by
 * scripts/org-escrow-decrypt.ts. Never imported by the running app.
 *
 * Usage:
 *   bun scripts/org-escrow-keygen.ts           # human-readable output
 *   bun scripts/org-escrow-keygen.ts --json    # { publicKey, privateKey, fingerprint }
 */

export type EscrowKeypair = {
  /** Base64 raw uncompressed P-256 point (65 bytes) — the VITE_ORG_ESCROW_PUBLIC_KEY value. */
  publicKey: string
  /** Base64 PKCS8 private key — operator-held, offline only. */
  privateKey: string
  /** base64(SHA-256(raw public key bytes)) — operator bookkeeping only; nothing stores or checks it. */
  fingerprint: string
}

/**
 * Generate an operator escrow keypair per the frozen THU-804 contract:
 * ECDH P-256 with `deriveBits` usage, public exported raw (65 bytes), private
 * exported PKCS8, fingerprint = base64(SHA-256(raw public key bytes)).
 */
export const generateEscrowKeypair = async (): Promise<EscrowKeypair> => {
  const keypair = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits'])
  const publicRaw = new Uint8Array(await crypto.subtle.exportKey('raw', keypair.publicKey))
  const privatePkcs8 = new Uint8Array(await crypto.subtle.exportKey('pkcs8', keypair.privateKey))
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', publicRaw))
  return {
    publicKey: Buffer.from(publicRaw).toString('base64'),
    privateKey: Buffer.from(privatePkcs8).toString('base64'),
    fingerprint: Buffer.from(digest).toString('base64'),
  }
}

const main = async (): Promise<void> => {
  const json = process.argv.includes('--json')
  const keypair = await generateEscrowKeypair()

  if (json) {
    console.log(JSON.stringify(keypair))
    return
  }

  console.log('Org escrow keypair generated (ECDH P-256).\n')
  console.log('Public key — pin this in the CLIENT build (never on the server):')
  console.log(`  VITE_ORG_ESCROW_PUBLIC_KEY=${keypair.publicKey}\n`)
  console.log('The server only needs ORG_ESCROW_ENABLED=true; it holds no escrow key.\n')
  console.log('Fingerprint (base64 SHA-256 of the raw public key, for your own records):')
  console.log(`  ${keypair.fingerprint}\n`)
  console.log('Private key (base64 PKCS8):')
  console.log(`  ${keypair.privateKey}\n`)
  console.log('⚠️  WARNING: Store the private key OFFLINE (e.g. printed + safe, or an')
  console.log('   air-gapped password manager). NEVER place it on the app server or in')
  console.log('   its environment — anyone holding it can decrypt every escrowed account.')
  console.log('   It is consumed only by scripts/org-escrow-decrypt.ts, run out of band.')
}

if (import.meta.main) {
  await main()
}
