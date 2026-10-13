/* UNLICENSED — license TBD. This file is not licensed under MPL-2.0.
 * All rights reserved. See admin/LICENSE.
 * Enterprise support and licensing: contact info@thunderbolt.io. */

import type { ReactNode } from 'react'
import { msg } from '@lingui/core/macro'
import { Bot, Boxes, Users, BookOpen, Plug, Cpu } from 'lucide-react'
import { SectionSidebar, type SectionNavGroup } from '@/layout/sidebar/section-sidebar'
import type { SidebarSection } from '@/layout/sidebar/types'

const groups: SectionNavGroup[] = [
  {
    id: 'manage',
    label: msg`Manage`,
    items: [
      { path: '/admin', label: msg`Agents`, icon: Bot },
      { path: '/admin/members', label: msg`Members`, icon: Users },
      { path: '/admin/groups', label: msg`Groups`, icon: Boxes },
    ],
  },
  {
    id: 'thunderbolt-agent',
    label: msg`Thunderbolt agent`,
    items: [
      { path: '/admin/thunderbolt/skills', label: msg`Skills`, icon: BookOpen },
      { path: '/admin/thunderbolt/mcp', label: msg`Connections`, icon: Plug },
      { path: '/admin/thunderbolt/models', label: msg`Models`, icon: Cpu },
    ],
  },
]

export const AdminSidebar = (props: {
  footer?: ReactNode
  isCollapsed: boolean
  onSectionChange: (section: SidebarSection) => void
  onNavigate: (path: string) => void
}) => <SectionSidebar {...props} activeSection="admin" groups={groups} />
