/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import {
  SiCloudflare,
  SiGithub,
  SiLinear,
  SiNotion,
  SiRender,
  SiSentry,
  SiStripe,
  SiSupabase,
  SiVercel,
} from '@icons-pack/react-simple-icons'
import { Blocks } from 'lucide-react'
import type { ComponentType, SVGProps } from 'react'

/**
 * Icon component shape shared by lucide-react and @icons-pack/react-simple-icons.
 * Both render an SVG and accept `className`/`color`, so callers can size and tint
 * them uniformly.
 */
export type McpIconComponent = ComponentType<SVGProps<SVGSVGElement>>

/**
 * Resolution of an MCP server URL to an icon component. Both simple-icons brand
 * glyphs and the lucide `Blocks` fallback default to `currentColor`
 * (monochrome), so no brand flag is needed to tint them uniformly.
 */
export type McpIcon = {
  icon: McpIconComponent
}

/**
 * Registrable domain → brand icon. Aliases (e.g. `githubcopilot.com`) point at
 * the same glyph as their canonical domain. Hosts not listed here fall back to
 * the generic `Blocks` glyph.
 */
const domainIcons: Record<string, McpIconComponent> = {
  'linear.app': SiLinear,
  'github.com': SiGithub,
  'githubcopilot.com': SiGithub,
  'notion.so': SiNotion,
  'notion.com': SiNotion,
  'render.com': SiRender,
  'sentry.io': SiSentry,
  'supabase.com': SiSupabase,
  'vercel.com': SiVercel,
  'cloudflare.com': SiCloudflare,
  'stripe.com': SiStripe,
}

/** Generic glyph for unknown / self-hosted hosts and tools with no resolved server. */
export const fallbackMcpIcon: McpIcon = { icon: Blocks }

/**
 * Extracts the hostname from a server URL, tolerating bare hosts (no scheme).
 * Returns the lowercased hostname, or null when nothing host-like is present.
 */
const extractHostname = (url: string): string | null => {
  const trimmed = url.trim()
  if (!trimmed) {
    return null
  }
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`
  try {
    return new URL(withScheme).hostname.toLowerCase()
  } catch {
    return null
  }
}

/**
 * Maps an MCP server URL (or bare host) to a brand icon, matching the
 * registrable domain against {@link domainIcons}. A hostname matches a domain
 * when it equals the domain or is a subdomain of it (`api.github.com` →
 * `github.com`). Unknown or self-hosted hosts fall back to the monochrome
 * `Blocks` glyph.
 */
export const getMcpIcon = (url: string): McpIcon => {
  const hostname = extractHostname(url)
  if (!hostname) {
    return fallbackMcpIcon
  }

  for (const [domain, icon] of Object.entries(domainIcons)) {
    if (hostname === domain || hostname.endsWith(`.${domain}`)) {
      return { icon }
    }
  }

  return fallbackMcpIcon
}
