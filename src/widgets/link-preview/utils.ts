/** Extracts a clean hostname from a URL (strips "www." prefix) */
export const getHostname = (url: string): string => {
  try {
    const parsed = new URL(url)
    return parsed.hostname.replace(/^www\./, '')
  } catch {
    // If URL parsing fails, try to extract hostname-like string from the input
    // This handles edge cases like malformed URLs while still providing some value
    const match = url.match(/^(?:https?:\/\/)?([^/\s?#]+)/i)
    return match ? match[1].replace(/^www\./, '') : url
  }
}
