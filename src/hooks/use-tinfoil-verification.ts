/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { getActiveTinfoilClient as getActiveTinfoilClient_default } from '@/ai/fetch'
import { useHttpClient } from '@/contexts'
import { useIntegrationStatus } from '@/hooks/use-integration-status'
import { useLocalSettingsStore } from '@/stores/local-settings-store'
import type { Model } from '@/types'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { VerificationDocument } from 'tinfoil'

export type VerificationStatus = 'idle' | 'verifying' | 'verified' | 'failed'

export type TinfoilVerification = {
  /** `idle` for any non-Tinfoil model (the chip renders nothing). */
  status: VerificationStatus
  doc: VerificationDocument | null
  error: string | null
  /** Force a fresh attestation read (used by the Error chip and the sidebar). */
  retry: () => void
}

// Mirrors tinfoil-webapp's backoff (constants.ts): up to 5 retries, 2s base,
// exponential 1.5^n. Attestation runs once per page load per enclave and the
// SecureClient is cached, so this normally resolves on the first attempt.
const maxRetries = 5
const baseRetryDelayMs = 2000

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

const isOnline = () => (typeof navigator !== 'undefined' ? navigator.onLine : true)

/**
 * Read the enclave verification document for the active Tinfoil model.
 *
 * Gated on `provider === 'tinfoil'` — NOT `isConfidential`: confidential
 * thunderbolt-provider models (e.g. GPT OSS) are served through Thunderbolt's
 * cloud and have no client-side SecureClient, so they stay `idle`.
 *
 * For a Tinfoil model it resolves the same attested SecureClient inference uses
 * (`getActiveTinfoilClient`), reads `getVerificationDocument()`, and caches the
 * result. It re-reads when the model, cloudUrl, or Tinfoil OAuth connection
 * changes (each can swap the enclave that answers). It does NOT re-attest per
 * message — the client attests once and is reused.
 *
 * `getActiveTinfoilClient` is injectable for tests; production callers pass only
 * `model`.
 */
export const useTinfoilVerification = (
  model: Model | null,
  getActiveTinfoilClient: typeof getActiveTinfoilClient_default = getActiveTinfoilClient_default,
): TinfoilVerification => {
  const httpClient = useHttpClient()
  const cloudUrl = useLocalSettingsStore((s) => s.cloudUrl)
  const { data: integrationStatus } = useIntegrationStatus()
  const tinfoilConnected = integrationStatus?.tinfoilConnected ?? false
  const tinfoilEnabled = integrationStatus?.tinfoilEnabled ?? false

  const isTinfoil = model?.provider === 'tinfoil'
  const modelId = model?.id ?? null

  const [status, setStatus] = useState<VerificationStatus>(isTinfoil ? 'verifying' : 'idle')
  const [doc, setDoc] = useState<VerificationDocument | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [retryNonce, setRetryNonce] = useState(0)

  // Reset synchronously when the active model changes so send-gating fails
  // closed immediately. Without this, switching between two Tinfoil models would
  // briefly expose the previous model's `verified` status (the effect that
  // re-attests runs only after commit), letting a send slip through. This is
  // React's documented "adjust state during render" pattern.
  const [prevModelId, setPrevModelId] = useState(modelId)
  if (modelId !== prevModelId) {
    setPrevModelId(modelId)
    setStatus(isTinfoil ? 'verifying' : 'idle')
    setDoc(null)
    setError(null)
  }

  const retry = useCallback(() => setRetryNonce((n) => n + 1), [])

  // Read the live model object from a ref so the effect re-runs only on inputs
  // that actually change which enclave answers (id / provider), not on unrelated
  // field edits.
  const modelRef = useRef(model)
  modelRef.current = model

  // The injected resolver can change identity between renders in tests; keep the
  // latest in a ref so it isn't a dependency that would re-trigger attestation.
  const getClientRef = useRef(getActiveTinfoilClient)
  getClientRef.current = getActiveTinfoilClient

  // Legitimate useEffect: an async side effect (enclave attestation read) with
  // cancellation cleanup. Re-runs when the active enclave could change.
  useEffect(() => {
    if (!isTinfoil) {
      setStatus('idle')
      setDoc(null)
      setError(null)
      return
    }

    let cancelled = false
    setStatus('verifying')
    setError(null)

    const run = async () => {
      const activeModel = modelRef.current
      if (!activeModel) {
        return
      }

      for (let attempt = 0; attempt <= maxRetries; attempt++) {
        if (cancelled) {
          return
        }
        if (!isOnline()) {
          await delay(baseRetryDelayMs)
          continue
        }
        try {
          // Awaits ready() under the hood, so a thrown error means attestation
          // could not complete (transient → retry).
          const client = await getClientRef.current(activeModel, httpClient)
          if (cancelled) {
            return
          }
          const nextDoc = client.getVerificationDocument()
          setDoc(nextDoc)
          setStatus(nextDoc.securityVerified ? 'verified' : 'failed')
          setError(nextDoc.securityVerified ? null : 'Enclave verification failed')
          return
        } catch (err) {
          if (cancelled) {
            return
          }
          if (attempt === maxRetries) {
            setStatus('failed')
            setError(err instanceof Error ? err.message : 'Verification failed')
            return
          }
          await delay(baseRetryDelayMs * Math.pow(1.5, attempt))
        }
      }

      // Reached only when every attempt found the device offline — surface a
      // terminal failure instead of leaving the chip stuck on "Verifying…".
      if (!cancelled) {
        setStatus('failed')
        setError('No network connection')
      }
    }

    void run()

    return () => {
      cancelled = true
    }
    // `tinfoilConnected` / `tinfoilEnabled` aren't read in the body but are
    // intentional re-trigger signals: connecting/disconnecting Tinfoil OAuth
    // switches getActiveTinfoilClient between the direct and managed enclaves
    // (different verification documents), so we must re-attest when they change.
  }, [isTinfoil, modelId, cloudUrl, tinfoilConnected, tinfoilEnabled, httpClient, retryNonce])

  return { status, doc, error, retry }
}
