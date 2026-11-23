/* UNLICENSED — license TBD. This file is not licensed under MPL-2.0.
 * All rights reserved. See admin/LICENSE.
 * Enterprise support and licensing: contact info@thunderbolt.io. */

import { msg } from '@lingui/core/macro'
import { Boxes, KeyRound, ScrollText, Users } from 'lucide-react'
import type { ReactNode } from 'react'
import { SectionSidebar, type SectionNavGroup } from '@/layout/sidebar/section-sidebar'
import type { SidebarSection } from '@/layout/sidebar/types'
import { usePendingLinkReviewCount } from './screens/members/use-pending-link-review-count'

/** The admin sidebar. Each entry matches a route in `admin-routes.tsx`. */
export const adminNavGroups: SectionNavGroup[] = [
  {
    id: 'people',
    label: msg`People`,
    items: [
      // The badge counts the identities waiting on Members for an admin to link them.
      { path: '/admin/members', label: msg`Members`, icon: Users, useBadge: usePendingLinkReviewCount },
      { path: '/admin/groups', label: msg`Groups`, icon: Boxes },
    ],
  },
  {
    id: 'security',
    label: msg`Security`,
    items: [
      { path: '/admin/sign-in-methods', label: msg`Sign-in methods`, icon: KeyRound },
      { path: '/admin/audit-log', label: msg`Audit log`, icon: ScrollText },
    ],
  },
]

type AdminSidebarProps = {
  isCollapsed: boolean
  onSectionChange: (section: SidebarSection) => void
  onNavigate: (path: string) => void
  onSearchClick?: () => void
  footer?: ReactNode
}

export const AdminSidebar = (props: AdminSidebarProps) => (
  <SectionSidebar {...props} activeSection="admin" groups={adminNavGroups} />
)
