/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import Foundation
import Observation

@MainActor
@Observable
final class ChatRun {
    let id = UUID()
    let replyID: String
    var status: String?
    @ObservationIgnored var task: Task<Void, Never>?

    init(replyID: String) { self.replyID = replyID }
}
