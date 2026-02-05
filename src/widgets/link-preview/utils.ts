/** Extracts a clean hostname from a URL (strips "www." prefix) */
export const getHostname = (url: string): string => {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return url
  }
}
