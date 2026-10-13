/* UNLICENSED — license TBD. This file is not licensed under MPL-2.0.
 * All rights reserved. See admin/LICENSE.
 * Enterprise support and licensing: contact info@thunderbolt.io. */

import { Navigate, Route, Routes } from 'react-router'
import { CompanySkillsPage } from './screens/company-skills-page'
import { CompanyModelsPage } from './screens/company-models-page'
import { CompanyMcpPage } from './screens/company-mcp-page'
import { AgentsPage } from './screens/agents-page'
import { MembersPage } from './screens/members-page'
import { GroupsPage } from './screens/groups-page'
import { useAdminPreviewState } from './use-admin-preview-state'

const AdminPage = () => {
  const preview = useAdminPreviewState()
  return (
    <Routes>
      <Route index element={<AgentsPage preview={preview} />} />
      <Route path="members" element={<MembersPage preview={preview} />} />
      <Route path="groups" element={<GroupsPage preview={preview} />} />
      <Route path="thunderbolt/skills" element={<CompanySkillsPage preview={preview} />} />
      <Route path="thunderbolt/mcp" element={<CompanyMcpPage preview={preview} />} />
      <Route path="thunderbolt/models" element={<CompanyModelsPage preview={preview} />} />
      <Route path="*" element={<Navigate to="/admin" replace />} />
    </Routes>
  )
}
export default AdminPage
