/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Models
export {
  createModel,
  deleteModel,
  getAllModels,
  getAvailableModels,
  getDefaultModelForThread,
  getModel,
  getModelQuery,
  getSelectedModel,
  getSelectedModelQuery,
  getSystemModel,
  resetModelToDefault,
  updateModel,
} from './models'

// Settings
export {
  createSetting,
  deleteSetting,
  getAllSettings,
  getSettings,
  getSettingsRecords,
  getThemeSetting,
  hasSetting,
  resetSettingToDefault,
  updateSettings,
} from './settings'

// Chat Threads
export {
  createChatThread,
  deleteAllChatThreads,
  deleteChatThread,
  getAllChatThreads,
  getChatThread,
  getContextSizeForThread,
  getOrCreateChatThread,
  isChatThreadDeleted,
  updateChatThread,
} from './chat-threads'

// Chat Messages
export {
  deleteChatMessageAndDescendants,
  getChatMessages,
  getLastMessage,
  saveMessagesWithContextUpdate,
  updateMessage,
} from './chat-messages'

// Tasks
export {
  createTask,
  deleteTask,
  deleteTasks,
  getAllTasks,
  getIncompleteTasks,
  getIncompleteTasksCount,
  updateTask,
} from './tasks'

// MCP Servers
export {
  createMcpServer,
  createMcpServersWithCredentials,
  createMcpServerWithCredentials,
  deleteMcpServer,
  getAllMcpServers,
  getRemoteMcpServers,
  updateMcpServer,
  type McpServerWithCredential,
} from './mcp-servers'

// MCP Secrets (local-only credentials)
export { deleteMcpServerCredentials, getMcpServerCredentials, setMcpServerCredentials } from './mcp-secrets'

// Prompts
export {
  createAutomation,
  deleteAutomation,
  getAllPrompts,
  getTriggerPromptForThread,
  resetAutomationToDefault,
  runAutomation,
  updateAutomation,
} from './prompts'

// Triggers
export {
  createTrigger,
  deleteTriggersForPrompt,
  deleteTriggersForPrompts,
  getAllEnabledTriggers,
  getAllTriggersForPrompt,
} from './triggers'

// Modes
export { getAllModes, getDefaultMode, getMode, getSelectedMode } from './modes'

// Model Profiles
export {
  createDefaultModelProfile,
  deleteModelProfileForModel,
  getModelProfile,
  resetModelProfileToDefault,
  upsertModelProfile,
} from './model-profiles'

// Devices
export { getAllDevices, getDevice, getPendingDevices, type Device } from './devices'

// Integrations
export {
  deleteIntegrationCredentials,
  getIntegrationCredentials,
  getIntegrationStatus,
  saveIntegrationCredentials,
  setIntegrationEnabled,
  updateIntegrationCredentials,
} from './integrations'

// Skills
export {
  createSkill,
  getAllSkills,
  getPinnedSkills,
  getSkill,
  getSkillByName,
  getSkillsByIds,
  maxPinnedSkills,
  PinLimitExceededError,
  reorderPins,
  setEnabled as setSkillEnabled,
  setPinned as setSkillPinned,
  SkillNameInvalidError,
  SkillNameTakenError,
  softDeleteSkill,
  updateSkill,
  validateSkillName,
  type CreateSkillInput,
  type UpdateSkillInput,
} from './skills'

// Workspaces
export {
  duplicateWorkspace,
  ensurePersonalWorkspace,
  getPersonalWorkspaceByOwner,
  getPersonalWorkspaceByOwnerQuery,
  getWorkspaceById,
  getWorkspaceByIdQuery,
  getWorkspacesForUserQuery,
  updateWorkspace,
  useWorkspacesQuery,
  type DuplicateWorkspaceInput,
  type UpdateWorkspacePatch,
  type Workspace,
} from './workspaces'
export {
  getMembership,
  getMembershipQuery,
  getMembershipsByUser,
  getMembershipsByWorkspace,
  getMembershipsByWorkspaceQuery,
  isWorkspaceAdmin,
  removeMembership,
  updateMembershipRole,
  useWorkspaceMembersQuery,
  type WorkspaceMembership,
} from './workspace-memberships'
export {
  addPendingMembership,
  getPendingByWorkspace,
  getPendingByWorkspaceQuery,
  removePendingMembership,
  updatePendingMembershipRole,
  useWorkspacePendingMembershipsQuery,
  type AddPendingMembershipInput,
  type WorkspacePendingMembership,
} from './workspace-pending-memberships'
export {
  getPermissionsByWorkspace,
  getPermissionsByWorkspaceQuery,
  getRequiredRoleForPermission,
  getRequiredRoleForPermissionQuery,
  setWorkspacePermissionRequiredRole,
  useWorkspacePermissionsQuery,
  type WorkspacePermission,
  type WorkspacePermissionKey,
  type WorkspacePermissionRole,
} from './workspace-permissions'

// Agents (ACP)
export {
  composeAllAgents,
  createAgent,
  deleteAgent,
  getAgentSecrets,
  getAllAgents,
  getAllSystemAgents,
  setAgentSecrets,
  updateAgent,
  useAgents,
  useAllAgents,
  useSystemAgents,
  type AgentSecrets,
  type CreateAgentInput,
  type UpdateAgentPatch,
} from './agents'
export { builtInAgent } from '../defaults/agents'
export { refreshSystemAgents, type RefreshSystemAgentsResult } from '../db/seeding/seed-agents'

// Export (user-data backup)
export { exportFormat, exportSchemaVersion, exportUserData, exportedTableNames, type UserDataExport } from './export'

// Import (restore exported data)
export {
  ImportFormatError,
  importUserData,
  summarizeExportEnvelope,
  type ExportSummary,
  type ImportResult,
} from './import'
