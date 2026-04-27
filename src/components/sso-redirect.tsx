import { useEffect } from 'react'
import { http } from '@/lib/http'
import { useSettings } from '@/hooks/use-settings'
import Loading from '@/loading'

/**
 * In SSO mode (OIDC or SAML), redirects unauthenticated users to the backend's
 * SSO sign-in endpoint, which redirects to the identity provider.
 */
const SsoRedirect = ({ providerId }: { providerId: string }) => {
  const { cloudUrl } = useSettings({ cloud_url: String })

  useEffect(() => {
    if (cloudUrl.isLoading || !cloudUrl.value) {
      return
    }

    const abortController = new AbortController()
    const baseUrl = cloudUrl.value.replace(/\/v1$/, '')

    const redirectToSso = async () => {
      try {
        const data = await http
          .post(`${baseUrl}/v1/api/auth/sign-in/sso`, {
            json: { providerId, callbackURL: window.location.origin + '/' },
            credentials: 'include',
            signal: abortController.signal,
          })
          .json<{ url: string }>()

        window.location.href = data.url
      } catch (err) {
        if (err instanceof DOMException && err.name === 'AbortError') {
          return
        }
        console.error('SSO redirect failed:', err)
      }
    }

    redirectToSso()

    return () => abortController.abort()
  }, [cloudUrl.isLoading, cloudUrl.value, providerId])

  return <Loading />
}

export default SsoRedirect
