import { useEffect } from 'react'
import { http } from '@/lib/http'
import { useSettings } from '@/hooks/use-settings'
import Loading from '@/loading'

/**
 * In OIDC mode, redirects unauthenticated users to the backend's OIDC sign-in endpoint,
 * which in turn redirects to the OIDC provider. The user never sees a login page on our app.
 */
const OidcRedirect = () => {
  const { cloudUrl } = useSettings({ cloud_url: String })

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
        const data = await http
          .post(`${baseUrl}/v1/api/auth/sign-in/oauth2`, {
            json: { providerId: 'oidc', callbackURL: window.location.origin + '/' },
            credentials: 'include',
            signal: abortController.signal,
          })
          .json<{ url: string }>()

        window.location.href = data.url
      } catch (err) {
        if (err instanceof DOMException && err.name === 'AbortError') {
          return
        }
        console.error('OIDC redirect failed:', err)
      }
    }

    redirectToOidc()

    return () => abortController.abort()
  }, [cloudUrl.isLoading, cloudUrl.value])

  return <Loading />
}

export default OidcRedirect
