/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Fixed TEST-ONLY org-escrow keypair for the E2EE suite (THU-804). Generated
 * with `bun scripts/org-escrow-keygen.ts --json`. The public half is injected
 * into the harness backend via ORG_ESCROW_PUBLIC_KEY (playwright.e2ee.config.ts);
 * the private half lets org-escrow.spec.ts run the offline decrypt tool.
 * Never use these keys outside the e2e harness.
 */

export const testOrgEscrowPublicKey =
  'BNPkxi77YSUg+N959nNzfaAkP0lYLrhrf1iSsOw/m+p7gvS1Wpgs5hud5cJtk7XdZViQQji13FrD6uUV0PgHPGk='

// Disposable throwaway keypair that exists only so the e2e suite can run the offline
// decrypt tool. It guards no real data and is never loaded by the app or any deployment.
// `p/secrets` runs in CI (.github/workflows/security.yml) and flags committed private
// keys — suppressed on both the declaration and the literal so the match lands either way.
// nosemgrep
export const testOrgEscrowPrivateKey =
  'MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgEDbnNrelhyr2euXcFspPm375JhlzsE9+bzgwYftp/qWhRANCAATT5MYu+2ElIPjfefZzc32gJD9JWC64a39YkrDsP5vqe4L0tVqYLOYbneXCbZO13WVYkEI4tdxaw+rlFdD4Bzxp' // nosemgrep

export const testOrgEscrowFingerprint = 'QFapO30ef0WmAvN8qcPPKvzKCIJlnSdeY4A0JndVUR8='
