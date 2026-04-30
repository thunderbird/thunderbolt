import { useEffect, useState } from 'react'
import { http } from '@/lib/http'
import { useSettings } from '@/hooks/use-settings'
import { Button } from '@/components/ui/button'
import Loading from '@/loading'

/** Validate that an OIDC redirect URL uses a safe protocol and optionally matches an expected origin. */
export const validateOidcRedirectUrl = (rawUrl: string, expectedOrigin?: string): URL => {
  const url = new URL(rawUrl)
  if (!(url.protocol === 'https:' || (url.protocol === 'http:' && (url.hostname === 'localhost' || url.hostname === '127.0.0.1')))) {
    throw new Error('OIDC redirect must use HTTPS')
  }
  if (expectedOrigin && url.origin !== expectedOrigin) {
    throw new Error(`OIDC redirect origin mismatch: expected ${expectedOrigin}`)
  }
  return url
}

/**
 * In OIDC mode, redirects unauthenticated users to the backend's OIDC sign-in endpoint,
 * which in turn redirects to the OIDC provider. The user never sees a login page on our app.
 */
const OidcRedirect = () => {
  const { cloudUrl } = useSettings({ cloud_url: String })
  const [error, setError] = useState<string | null>(null)

  // Legitimate useEffect: triggers an external navigation side-effect (redirect to OIDC provider)
  // that depends on an async setting value. Cannot be computed during render.
  useEffect(() => {
    if (cloudUrl.isLoading || !cloudUrl.value) {
      return
    }

    const abortController = new AbortController()
    const baseUrl = cloudUrl.value.replace(/\/v1$/, '')

    // Use credentials: 'include' so the browser stores Better Auth's OAuth state cookie.
    // Without it, the state cookie is lost and the callback fails with state_mismatch.
    const redirectToOidc = async () => {
      try {
        // Fetch expected issuer origin (best-effort — falls back to protocol-only if unavailable)
        let expectedOrigin: string | undefined
        try {
          const config = await http.get(`${baseUrl}/v1/auth/oidc/config`).json<{ issuerOrigin: string }>()
          expectedOrigin = config.issuerOrigin
        } catch {
          // Config not available (non-OIDC mode or network issue) — continue with protocol-only validation
        }

        const data = await http
          .post(`${baseUrl}/v1/api/auth/sign-in/oauth2`, {
            json: { providerId: 'oidc', callbackURL: window.location.origin + '/' },
            credentials: 'include',
            signal: abortController.signal,
          })
          .json<{ url: string }>()

        const validatedUrl = validateOidcRedirectUrl(data.url, expectedOrigin)
        window.location.href = validatedUrl.href
      } catch (err) {
        if (err instanceof DOMException && err.name === 'AbortError') {
          return
        }
        console.error('OIDC redirect failed:', err)
        setError('Failed to start authentication. Please try again or contact your administrator.')
      }
    }

    redirectToOidc()

    return () => abortController.abort()
  }, [cloudUrl.isLoading, cloudUrl.value])

  if (error) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-4">
        <p className="text-[length:var(--font-size-sm)] text-destructive">{error}</p>
        <Button variant="outline" onClick={() => window.location.reload()}>
          Try again
        </Button>
      </div>
    )
  }

  return <Loading />
}

export default OidcRedirect
