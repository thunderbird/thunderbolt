/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import SwiftUI

@main
struct ThunderboltApp: App {
    @Environment(\.scenePhase) private var scenePhase
    @State private var model: AppModel
    @State private var externalLink: URL?

    private var isUnitTestHost: Bool {
        #if DEBUG
        NSClassFromString("XCTestCase") != nil
        #else
        false
        #endif
    }

    init() {
        #if DEBUG
        let environment = ProcessInfo.processInfo.environment
        let isUITest = environment["THUNDERBOLT_UI_TESTING"] == "1"
        let defaults = isUITest ? UserDefaults(suiteName: "ThunderboltUITests")! : .standard
        let server = environment["THUNDERBOLT_SERVER_URL"]
        let store = KeychainSessionStore(service: isUITest ? "thunderbolt.native.ui-tests" : "net.thunderbird.thunderbolt.native.session")
        if environment["THUNDERBOLT_RESET_SESSION"] == "1", let server,
           let address = try? ServerAddress.normalize(server) {
            try? store.save(nil, server: address.absoluteString)
        }
        let directory = URL.applicationSupportDirectory.appending(path: isUITest ? "UITestConversations" : "Conversations")
        _model = State(initialValue: AppModel(serverURL: server, defaults: defaults, sessionStore: store,
                                            conversationStore: FileConversationStore(directory: directory)))
        #else
        _model = State(initialValue: AppModel())
        #endif
    }

    var body: some Scene {
        WindowGroup {
            ContentView(model: model)
                .preferredColorScheme(NativeDevicePreferences.shared.preferredColorScheme)
                .environment(\.openURL, OpenURLAction { url in
                    guard ["https", "http", "mailto", "tel"].contains(url.scheme?.lowercased() ?? "") else { return .discarded }
                    if NativeDevicePreferences.shared.externalLinkBehavior == "browser" { return .systemAction }
                    externalLink = url
                    return .handled
                })
                .confirmationDialog("Open link?", isPresented: Binding(get: { externalLink != nil }, set: { if !$0 { externalLink = nil } })) {
                    if let externalLink {
                        Button("Open in browser") { UIApplication.shared.open(externalLink); self.externalLink = nil }
                    }
                    Button("Cancel", role: .cancel) { externalLink = nil }
                } message: {
                    if let externalLink { Text(externalLink.absoluteString) }
                }
                .onOpenURL { url in Task { await model.handleProviderCallback(url) } }
                .environment(\.locale, Locale(identifier: NativeLocalization.language))
                .onChange(of: model.preferences?.value(for: .language), initial: true) { _, value in
                    NativeLocalization.setLanguage(value ?? Locale.preferredLanguages.first ?? "en")
                }
                .task {
                    guard !isUnitTestHost else { return }
                    async let configuration: Void = model.loadAuthConfiguration()
                    await model.restore()
                    await configuration
                }
                .onChange(of: scenePhase) { _, phase in
                    guard !isUnitTestHost else { return }
                    if phase == .background { Task { await model.stopVoice(); await model.stopAll() } }
                    if phase == .active { Task { await model.reconnect() } }
                }
                .task {
                    guard !isUnitTestHost else { return }
                    for await _ in NativeConnectivity.restoredConnections() { await model.reconnect() }
                }
        }
    }
}
