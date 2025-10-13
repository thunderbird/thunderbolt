import { getCloudUrl } from '@/lib/config'
import { useEffect, useState } from 'react'

export const useCloudUrl = () => {
  const [cloudUrl, setCloudUrl] = useState<string>('')

  useEffect(() => {
    getCloudUrl().then(setCloudUrl)
  }, [])

  return cloudUrl
}
