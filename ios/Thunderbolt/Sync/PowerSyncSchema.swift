// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/.

import Foundation
import PowerSync

enum NativeSyncColumnType: Sendable {
    case text
    case integer
    case real

    var powerSyncColumn: ColumnData {
        switch self {
        case .text: .text
        case .integer: .integer
        case .real: .real
        }
    }
}

struct NativeSyncColumn: Sendable {
    let name: String
    let type: NativeSyncColumnType
}

struct NativeSyncTable: Sendable {
    let name: String
    let columns: [NativeSyncColumn]
    let encryptedColumns: Set<String>
    let localOnly: Bool
    let trackMetadata: Bool
    let hasSoftDelete: Bool

    var powerSyncTable: Table {
        Table(
            name: name,
            columns: columns.map { Column(name: $0.name, type: $0.type.powerSyncColumn) },
            localOnly: localOnly,
            trackMetadata: trackMetadata
        )
    }

    func column(named name: String) -> NativeSyncColumn? {
        columns.first { $0.name == name }
    }
}

/// Native mirror of `shared/powersync-tables.ts`, `src/db/tables.ts`, and the
/// local-only declarations in `src/db/powersync/schema.ts`. Keep these names and
/// snake_case columns aligned with the web/Tauri schema and PowerSync rules.
enum NativePowerSyncSchema {
    static let tables: [NativeSyncTable] = [
        synced("settings", text: ["value", "updated_at", "default_hash", "user_id"], encrypted: ["value"]),
        synced("chat_threads", text: ["title", "triggered_by", "acp_session_id", "agent_id", "project_id", "mini_app_id", "deleted_at", "user_id"], integer: ["is_encrypted", "was_triggered_by_automation", "context_size"], encrypted: ["title"], softDelete: true),
        synced("chat_messages", text: ["content", "role", "parts", "chat_thread_id", "model_id", "parent_id", "cache", "metadata", "deleted_at", "user_id"], encrypted: ["content", "parts", "cache", "metadata"], softDelete: true),
        synced("tasks", text: ["item", "default_hash", "deleted_at", "user_id"], integer: ["order", "is_complete"], encrypted: ["item"], softDelete: true),
        synced("models", text: ["provider_connection_id", "provider", "name", "model", "url", "reasoning_effort", "deleted_at", "default_hash", "vendor", "description", "user_id"], integer: ["is_system", "enabled", "tool_usage", "is_confidential", "start_with_reasoning", "supports_parallel_tool_calls", "context_window"], encrypted: ["name", "model", "url", "provider_connection_id", "vendor", "description"], softDelete: true, trackMetadata: true),
        synced("provider_connections", text: ["provider", "name", "url", "auth_method", "created_at", "updated_at", "deleted_at", "user_id"], integer: ["enabled"], encrypted: ["name", "url"], softDelete: true, trackMetadata: true),
        synced("prompts", text: ["title", "prompt", "model_id", "deleted_at", "default_hash", "user_id"], encrypted: ["title", "prompt"], softDelete: true),
        synced("skills", text: ["name", "label", "description", "instruction", "deleted_at", "default_hash", "user_id"], integer: ["enabled", "pinned_order"], encrypted: ["name", "label", "description", "instruction"], softDelete: true),
        synced("triggers", text: ["trigger_type", "trigger_time", "prompt_id", "deleted_at", "user_id"], integer: ["is_enabled"], encrypted: ["trigger_time"], softDelete: true),
        synced("model_profiles", text: ["tools_override", "link_previews_override", "chat_mode_addendum", "search_mode_addendum", "research_mode_addendum", "citation_reinforcement_prompt", "nudge_final_step", "nudge_preventive", "nudge_retry", "nudge_search_final_step", "nudge_search_preventive", "nudge_search_retry", "provider_options", "default_hash", "deleted_at", "user_id"], integer: ["max_steps", "max_attempts", "nudge_threshold", "use_system_message_mode_developer", "citation_reinforcement_enabled"], real: ["temperature"], encrypted: ["tools_override", "link_previews_override", "chat_mode_addendum", "search_mode_addendum", "research_mode_addendum", "citation_reinforcement_prompt", "nudge_final_step", "nudge_preventive", "nudge_retry", "nudge_search_final_step", "nudge_search_preventive", "nudge_search_retry", "provider_options"], softDelete: true),
        synced("devices", text: ["user_id", "name", "public_key", "mlkem_public_key", "last_seen", "created_at", "revoked_at", "device_type", "node_id", "node_id_attested_at"], integer: ["trusted", "approval_pending"], encrypted: ["name"]),
        synced("agents", text: ["name", "type", "transport", "url", "description", "icon", "deleted_at", "user_id"], integer: ["enabled"], encrypted: ["name", "url", "description"], softDelete: true),
        synced("projects", text: ["name", "description", "instructions", "icon", "created_at", "updated_at", "deleted_at", "user_id"], integer: ["pinned_order"], encrypted: ["name", "description", "instructions"], softDelete: true),

        local("provider_connection_secrets", text: ["credentials", "binding"]),
        local("models_secrets", text: ["api_key", "oauth_provider"], integer: ["provider_default"]),
        local("integrations_secrets", text: ["credentials"], integer: ["enabled"]),
        local("mcp_servers", text: ["name", "type", "url", "command", "args", "created_at", "updated_at", "deleted_at", "user_id"], integer: ["enabled"], softDelete: true),
        local("mcp_secrets", text: ["credentials"]),
        local("agents_system", text: ["name", "type", "transport", "url", "description", "icon", "fetched_at"], integer: ["is_default"]),
        local("agents_secrets", text: ["api_key", "auth_method"]),
    ]

    static let synchronizedTables = tables.filter { !$0.localOnly }
    static let localOnlyTables = tables.filter(\.localOnly)
    static let schema = Schema(tables: tables.map(\.powerSyncTable))
    static let byName = Dictionary(uniqueKeysWithValues: tables.map { ($0.name, $0) })

    private static func synced(
        _ name: String,
        text: [String] = [],
        integer: [String] = [],
        real: [String] = [],
        encrypted: [String] = [],
        softDelete: Bool = false,
        trackMetadata: Bool = false
    ) -> NativeSyncTable {
        NativeSyncTable(
            name: name,
            columns: columns(text: text, integer: integer, real: real),
            encryptedColumns: Set(encrypted),
            localOnly: false,
            trackMetadata: trackMetadata,
            hasSoftDelete: softDelete
        )
    }

    private static func local(
        _ name: String,
        text: [String] = [],
        integer: [String] = [],
        real: [String] = [],
        softDelete: Bool = false
    ) -> NativeSyncTable {
        NativeSyncTable(
            name: name,
            columns: columns(text: text, integer: integer, real: real),
            encryptedColumns: [],
            localOnly: true,
            trackMetadata: false,
            hasSoftDelete: softDelete
        )
    }

    private static func columns(text: [String], integer: [String], real: [String]) -> [NativeSyncColumn] {
        text.map { NativeSyncColumn(name: $0, type: .text) } +
            integer.map { NativeSyncColumn(name: $0, type: .integer) } +
            real.map { NativeSyncColumn(name: $0, type: .real) }
    }
}
