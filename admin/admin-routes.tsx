/* UNLICENSED — license TBD. This file is not licensed under MPL-2.0.
 * All rights reserved. See admin/LICENSE.
 * Enterprise support and licensing: contact info@thunderbolt.io. */

import { Navigate, Route, Routes } from 'react-router'
import { AuditLogPage } from './screens/audit-log/audit-log-page'
import { BreakGlassPage } from './screens/break-glass/break-glass-page'
import { DomainsPage } from './screens/domains/domains-page'
import { GroupsPage } from './screens/groups/groups-page'
import { IdentityProvidersPage } from './screens/identity-providers/identity-providers-page'
import { InvitationsPage } from './screens/invitations/invitations-page'
import { LinkReviewsPage } from './screens/link-reviews/link-reviews-page'
import { MembersPage } from './screens/members/members-page'

/** The admin screens, mounted at `/admin/*`. A detail panel opens through `?edit=<id>`, never a nested route. */
const AdminRoutes = () => (
  <Routes>
    <Route index element={<Navigate to="members" replace />} />
    <Route path="members" element={<MembersPage />} />
    <Route path="groups" element={<GroupsPage />} />
    <Route path="invitations" element={<InvitationsPage />} />
    <Route path="identity-providers" element={<IdentityProvidersPage />} />
    <Route path="domains" element={<DomainsPage />} />
    <Route path="link-reviews" element={<LinkReviewsPage />} />
    <Route path="audit-log" element={<AuditLogPage />} />
    <Route path="break-glass" element={<BreakGlassPage />} />
    <Route path="*" element={<Navigate to="/admin/members" replace />} />
  </Routes>
)

export default AdminRoutes
