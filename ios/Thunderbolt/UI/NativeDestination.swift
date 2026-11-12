/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import SwiftUI

enum NativeDestination: String, Identifiable {
    case preferences, models, skills, connections, devices, voice, tasks, account
    var id: String { rawValue }

    var title: String {
        switch self {
        case .preferences: nativeString("Preferences")
        case .models: nativeString("Models")
        case .skills: nativeString("Skills")
        case .connections: nativeString("Connections")
        case .devices: nativeString("Devices")
        case .voice: nativeString("Voice")
        case .tasks: nativeString("Tasks")
        case .account: nativeString("Account")
        }
    }

    var symbol: String {
        switch self {
        case .preferences: "slider.horizontal.3"
        case .models: "cpu"
        case .skills: "bolt"
        case .connections: "powerplug"
        case .devices: "iphone"
        case .voice: "waveform"
        case .tasks: "checklist"
        case .account: "person.crop.circle"
        }
    }

    var controlID: String {
        switch self {
        case .preferences: "openPreferencesSettings"
        case .models: "openModelsSettings"
        case .skills: "openSkillsSettings"
        case .connections: "openConnectionsSettings"
        case .devices: "openDevices"
        case .voice: "openVoiceSettings"
        case .tasks: "openTasks"
        case .account: "accountSettings"
        }
    }
}

struct NativeDestinationView: View {
    let destination: NativeDestination
    @Bindable var model: AppModel

    var body: some View {
        switch destination {
        case .preferences:
            if let preferences = model.preferences { PreferencesSettingsView(preferences: preferences) }
        case .models:
            if let library = model.modelLibrary { ModelsSettingsView(library: library) }
        case .skills:
            if let library = model.skillLibrary { SkillsSettingsView(library: library) }
        case .connections:
            if let library = model.connectionLibrary { NativeConnectionsView(library: library) }
        case .devices: DevicesView(model: model)
        case .voice:
            if let store = model.voicePreferences { NativeVoiceSettingsView(store: store, customProviderEnabled: model.customVoiceEnabled) }
        case .tasks:
            if let library = model.tasksLibrary { TasksView(library: library, isEnabled: model.preferences?.tasksEnabled == true) }
        case .account: SettingsView(model: model)
        }
    }
}
