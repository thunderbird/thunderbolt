/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import Foundation

enum NativePromptContext {
    /// Supplies the canonical TypeScript prompt builder with the same account
    /// settings and profile fields used by the Tauri chat engine.
    static func make(
        model: NativeModelRuntimeConfiguration,
        settings: [String: String],
        projectSection: String?,
        availableToolNames: [String]
    ) -> ChatJSONValue {
        let locale = Locale.current
        let region = locale.region?.identifier ?? "US"
        let timePattern = DateFormatter.dateFormat(fromTemplate: "j", options: 0, locale: locale) ?? "h a"
        var location: [String: ChatJSONValue] = [:]
        if let name = settings["location_name"] { location["name"] = .string(name) }
        if let lat = settings["location_lat"].flatMap(Double.init) { location["lat"] = .number(lat) }
        if let lng = settings["location_lng"].flatMap(Double.init) { location["lng"] = .number(lng) }
        var profile: [String: ChatJSONValue] = [:]
        if let value = model.profile?.toolsOverride { profile["toolsOverride"] = .string(value) }
        if let value = model.profile?.linkPreviewsOverride { profile["linkPreviewsOverride"] = .string(value) }
        if let value = model.profile?.chatModeAddendum { profile["chatModeAddendum"] = .string(value) }
        return .object([
            "modelName": .string(model.model.name),
            "profile": model.profile == nil ? .null : .object(profile),
            "preferredName": .string(settings["preferred_name"] ?? ""),
            "location": .object(location),
            "localization": .object([
                "distanceUnit": .string(settings["distance_unit"] ?? (["US", "LR", "GB", "MM"].contains(region) ? "imperial" : "metric")),
                "temperatureUnit": .string(settings["temperature_unit"] ?? (["US", "BS", "BZ", "KY", "PR", "PW"].contains(region) ? "f" : "c")),
                "timeFormat": .string(settings["time_format"] ?? (timePattern.contains("a") ? "12h" : "24h")),
                "currency": .string(settings["currency"] ?? locale.currency?.identifier ?? "USD"),
            ]),
            "integrationStatus": .string("No connected integrations"),
            "availableToolNames": .array(availableToolNames.map(ChatJSONValue.string)),
            "supportsTools": .bool(!availableToolNames.isEmpty),
            "appLanguage": .string(settings["language"] ?? "en"),
            "projectSection": projectSection.map(ChatJSONValue.string) ?? .null,
        ])
    }
}
