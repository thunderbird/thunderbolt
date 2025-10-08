import { useEffect, useState } from 'react'
import { getCloudUrl } from '@/lib/config'

export const useCloudUrl = () => {
  const [cloudUrl, setCloudUrl] = useState<string>('')

  useEffect(() => {
    getCloudUrl().then(setCloudUrl)
  }, [])

  return cloudUrl
}
