/** Extracts a clean hostname from a URL (strips "www." prefix) */
export const getHostname = (url: string): string => {
  if (!url || !url.trim()) {
    return 'Unknown'
  }

  try {
    const parsed = new URL(url)
    const hostname = parsed.hostname.replace(/^www\./, '')
    return hostname || 'Unknown'
  } catch {
    // If URL parsing fails, try to extract hostname-like string from the input
    // This handles edge cases like malformed URLs while still providing some value
    const match = url.match(/^(?:https?:\/\/)?([^/\s?#]+)/i)
    if (match && match[1]) {
      const hostname = match[1].replace(/^www\./, '')
      return hostname.length > 50 ? `${hostname.slice(0, 47)}...` : hostname
    }
    return url.length > 50 ? `${url.slice(0, 47)}...` : url
  }
}
