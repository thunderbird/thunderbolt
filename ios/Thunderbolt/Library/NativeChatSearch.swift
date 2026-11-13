/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import Foundation
import JavaScriptCore

enum NativeChatSearch {
    /// Reuses Tauri's content-language query planner. No UI locale enters the
    /// index, so mixed-language accounts keep the same matching semantics.
    static func plan(_ query: String) throws -> NativeProjectSearch.Query {
        guard let url = Bundle.main.url(forResource: "search-plan", withExtension: "js"), let context = JSContext() else {
            throw CocoaError(.fileNoSuchFile)
        }
        context.evaluateScript(try String(contentsOf: url, encoding: .utf8))
        let result = context.objectForKeyedSubscript("__thunderboltSearchPlan")?.call(withArguments: [query])
        if let error = context.exception { throw NativeLocalToolError.searchFailed(error.toString() ?? "Search planning failed.") }
        guard let json = result?.toString() else { throw CloudError.invalidResponse }
        return try JSONDecoder().decode(NativeProjectSearch.Query.self, from: Data(json.utf8))
    }

    static func find(_ query: String, conversations: [Conversation]) throws -> [NativeProjectSearch.Hit] {
        let hits = try NativeProjectSearch.search(conversations, query: plan(query), includeTitles: true, limit: 50)
        var seen: Set<String> = []
        return hits.filter { seen.insert($0.threadID).inserted }
    }
}
