/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import SwiftUI

struct NativeAskOption: Codable, Equatable, Sendable, Identifiable {
    let id: String
    let text: String
    let isCorrect: Bool?
}

struct NativeAskResponse: Equatable, Sendable {
    let messageID: String
    let storageKey: String
    let prompt: String
    let mode: String
    let selectedIDs: [String]
    let chosenTexts: [String]
    let matched: Bool?
    let conversationalTurnText: String?
}

struct NativeWidgetView: View {
    let widget: NativeWidget
    var messageID = ""
    var sources: [ChatContentSource] = []
    var cache: ChatJSONValue?
    var onAskResponse: ((NativeAskResponse) async throws -> Void)?

    var body: some View {
        Group {
            switch widget.name {
            case "ask":
                NativeAskWidget(widget: widget, messageID: messageID, cache: cache, onResponse: onAskResponse)
            case "citation":
                NativeCitationWidget(widget: widget)
            case "connect-integration":
                NativeConnectWidget(widget: widget)
            case "document-result":
                NativeDocumentWidget(widget: widget)
            case "link-preview":
                NativeLinkWidget(widget: widget, sources: sources)
            case "map":
                NativeMapWidget(widget: widget)
            case "weather-forecast":
                NativeWeatherWidget(widget: widget)
            default:
                EmptyView()
            }
        }
    }
}

private struct NativeAskWidget: View {
    let widget: NativeWidget
    let messageID: String
    let cache: ChatJSONValue?
    let onResponse: ((NativeAskResponse) async throws -> Void)?

    @State private var selectedIDs = Set<String>()
    @State private var submitted = false
    @State private var isSubmitting = false
    @State private var matched: Bool?
    @State private var submissionError: String?

    init(widget: NativeWidget, messageID: String, cache: ChatJSONValue?, onResponse: ((NativeAskResponse) async throws -> Void)?) {
        self.widget = widget
        self.messageID = messageID
        self.cache = cache
        self.onResponse = onResponse
        let prompt = widget.arguments["prompt"] ?? ""
        let mode = widget.arguments["mode"] ?? "free"
        let options = Self.decodeOptions(widget.arguments["options"])
        let key = Self.storageKey(prompt: prompt, mode: mode, options: options)
        let response = cache?[key]
        _selectedIDs = State(initialValue: Set(response?["selectedIds"]?.arrayValue?.compactMap(\.stringValue) ?? []))
        _submitted = State(initialValue: response != nil)
        _matched = State(initialValue: response?["matched"]?.boolValue)
    }

    private var prompt: String { widget.arguments["prompt"] ?? "" }
    private var mode: String { widget.arguments["mode"] ?? "free" }
    private var options: [NativeAskOption] {
        Self.decodeOptions(widget.arguments["options"])
    }
    private var allowsMultiple: Bool { mode == "multiple" || mode == "choices" }
    private var isGraded: Bool { mode == "single" || mode == "multiple" }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(alignment: .firstTextBaseline, spacing: 7) {
                Image(systemName: "sparkles").foregroundStyle(TBPalette.brand)
                Text(allowsMultiple ? nativeString("Select all that apply") : isGraded ? nativeString("Choose one") : nativeString("Your call"))
                    .font(.caption.weight(.medium)).textCase(.uppercase).tracking(0.5).foregroundStyle(TBPalette.muted)
            }
            Text(prompt).font(.headline).fixedSize(horizontal: false, vertical: true)
            if mode == "free" {
                Text(nativeString( "Answer in the message composer."))
                    .font(.subheadline).foregroundStyle(TBPalette.muted)
            } else {
                ForEach(options) { option in optionRow(option) }
                if submitted {
                    feedback
                } else {
                    Button(isSubmitting ? nativeString( "Saving…") : nativeString( "Submit")) { Task { await submit() } }
                        .buttonStyle(TBPrimaryButtonStyle())
                        .disabled(selectedIDs.isEmpty || isSubmitting)
                        .frame(maxWidth: .infinity, minHeight: 42)
                }
                if let submissionError {
                    Text(submissionError).font(.caption).foregroundStyle(.red).fixedSize(horizontal: false, vertical: true)
                }
            }
        }
        .padding(16)
        .background(TBPalette.surface, in: RoundedRectangle(cornerRadius: 18))
        .overlay(RoundedRectangle(cornerRadius: 18).stroke(TBPalette.border, lineWidth: 1))
        .accessibilityElement(children: .contain)
    }

    private func optionRow(_ option: NativeAskOption) -> some View {
        let isSelected = selectedIDs.contains(option.id)
        return Button {
            guard !submitted else { return }
            if allowsMultiple {
                if isSelected { selectedIDs.remove(option.id) } else { selectedIDs.insert(option.id) }
            } else {
                selectedIDs = [option.id]
            }
            if mode == "choice" { Task { await submit() } }
        } label: {
            HStack(alignment: .top, spacing: 10) {
                Image(systemName: isSelected ? (allowsMultiple ? "checkmark.square.fill" : "largecircle.fill.circle") : (allowsMultiple ? "square" : "circle"))
                    .foregroundStyle(isSelected ? TBPalette.brand : TBPalette.muted)
                Text(option.text).foregroundStyle(TBPalette.foreground).frame(maxWidth: .infinity, alignment: .leading)
                if submitted, isGraded {
                    if option.isCorrect == true {
                        Image(systemName: "checkmark.circle.fill").foregroundStyle(.green)
                    } else if isSelected {
                        Image(systemName: "xmark.circle.fill").foregroundStyle(.red)
                    }
                }
            }
            .font(.body)
            .padding(.horizontal, 12)
            .padding(.vertical, 11)
            .background(isSelected ? TBPalette.brand.opacity(0.09) : TBPalette.background, in: RoundedRectangle(cornerRadius: 12))
            .overlay(RoundedRectangle(cornerRadius: 12).stroke(isSelected ? TBPalette.brand.opacity(0.55) : TBPalette.border, lineWidth: 1))
            .contentShape(RoundedRectangle(cornerRadius: 12))
        }
        .buttonStyle(.plain)
        .disabled(submitted)
        .accessibilityAddTraits(isSelected ? .isSelected : [])
    }

    @ViewBuilder
    private var feedback: some View {
        if let matched {
            Label(matched ? nativeString( "Correct") : nativeString( "Try again"), systemImage: matched ? "checkmark.circle.fill" : "xmark.circle.fill")
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(matched ? .green : TBPalette.brandAmber)
        } else {
            Label(nativeString( "Response recorded"), systemImage: "checkmark.circle.fill")
                .font(.subheadline.weight(.semibold)).foregroundStyle(.green)
        }
        if let explanation = widget.arguments["explanation"], !explanation.isEmpty {
            Text(explanation).font(.subheadline).foregroundStyle(TBPalette.muted).fixedSize(horizontal: false, vertical: true)
        }
    }

    private func submit() async {
        guard !submitted, !isSubmitting, !selectedIDs.isEmpty else { return }
        let chosen = options.filter { selectedIDs.contains($0.id) }
        let correct = Set(options.filter { $0.isCorrect == true }.map(\.id))
        let isMatch: Bool? = isGraded ? (correct == selectedIDs) : nil
        let chosenTexts = chosen.map(\.text)
        let response = NativeAskResponse(
            messageID: messageID,
            storageKey: Self.storageKey(prompt: prompt, mode: mode, options: options),
            prompt: prompt,
            mode: mode,
            selectedIDs: chosen.map(\.id),
            chosenTexts: chosenTexts,
            matched: isMatch,
            conversationalTurnText: isGraded ? nil : chosenTexts.joined(separator: ", ")
        )
        isSubmitting = true
        submissionError = nil
        do {
            try await onResponse?(response)
            submitted = true
            matched = isMatch
        } catch {
            submissionError = error.localizedDescription
        }
        isSubmitting = false
    }

    private static func storageKey(prompt: String, mode: String, options: [NativeAskOption]) -> String {
        let encodedOptions = options.map { option -> String in
            var fields = ["\"id\":\(jsonString(option.id))", "\"text\":\(jsonString(option.text))"]
            if let isCorrect = option.isCorrect { fields.append("\"isCorrect\":\(isCorrect ? "true" : "false")") }
            return "{\(fields.joined(separator: ","))}"
        }
        let json = "{\"mode\":\(jsonString(mode)),\"options\":[\(encodedOptions.joined(separator: ","))]}"
        var hash: UInt32 = 5381
        for unit in json.utf16 { hash = (hash &* 33) &+ UInt32(unit) }
        return "ask/\(prompt)#\(String(hash, radix: 36))"
    }

    private static func jsonString(_ value: String) -> String {
        guard let data = try? JSONEncoder().encode(value) else { return "\"\"" }
        return String(decoding: data, as: UTF8.self)
    }

    private static func decodeOptions(_ value: String?) -> [NativeAskOption] {
        guard let value, let data = value.data(using: .utf8) else { return [] }
        return (try? JSONDecoder().decode([NativeAskOption].self, from: data)) ?? []
    }
}

private struct NativeCitationWidget: View {
    let widget: NativeWidget
    private var sources: [CitationSource] {
        guard let raw = widget.arguments["sources"] else { return [] }
        let json: Data?
        if raw.trimmingCharacters(in: .whitespacesAndNewlines).hasPrefix("[") {
            json = raw.data(using: .utf8)
        } else {
            json = Data(base64Encoded: raw)
        }
        guard let json else { return [] }
        return (try? JSONDecoder().decode([CitationSource].self, from: json)) ?? []
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 9) {
            Label(nativeString( "Sources"), systemImage: "link")
                .font(.subheadline.weight(.semibold)).foregroundStyle(TBPalette.muted)
            ForEach(Array(sources.enumerated()), id: \.offset) { index, source in
                if let url = URL(string: source.url), ["https", "http"].contains(url.scheme?.lowercased() ?? "") {
                    Link(destination: url) {
                        HStack(alignment: .top, spacing: 10) {
                            Text("\(index + 1)").font(.caption.weight(.bold)).foregroundStyle(TBPalette.brand)
                            VStack(alignment: .leading, spacing: 3) {
                                Text(source.title).font(.subheadline.weight(.medium)).foregroundStyle(TBPalette.foreground).lineLimit(2)
                                Text(source.siteName ?? url.host ?? source.url).font(.caption).foregroundStyle(TBPalette.muted).lineLimit(1)
                            }
                            Spacer(minLength: 0)
                            Image(systemName: "arrow.up.right").font(.caption).foregroundStyle(TBPalette.muted)
                        }
                        .contentShape(Rectangle())
                    }.buttonStyle(.plain)
                }
            }
        }
        .padding(14)
        .background(TBPalette.surface, in: RoundedRectangle(cornerRadius: 16))
        .overlay(RoundedRectangle(cornerRadius: 16).stroke(TBPalette.border, lineWidth: 1))
    }
}

private struct CitationSource: Decodable {
    let id: String
    let title: String
    let url: String
    let siteName: String?
}

private struct NativeConnectWidget: View {
    let widget: NativeWidget

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Label(nativeString( "Connect an account"), systemImage: "person.crop.circle.badge.plus")
                .font(.headline).foregroundStyle(TBPalette.foreground)
            Text(widget.arguments["reason"]?.isEmpty == false ? widget.arguments["reason"]! : nativeString( "This response needs access to an account integration."))
                .font(.subheadline).foregroundStyle(TBPalette.muted).fixedSize(horizontal: false, vertical: true)
            Text(nativeString( "Manage connected accounts in Settings."))
                .font(.caption).foregroundStyle(TBPalette.muted)
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(TBPalette.surface, in: RoundedRectangle(cornerRadius: 16))
        .overlay(RoundedRectangle(cornerRadius: 16).stroke(TBPalette.border, lineWidth: 1))
    }
}

private struct NativeDocumentWidget: View {
    let widget: NativeWidget

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Label(widget.arguments["name"] ?? nativeString( "Document"), systemImage: "doc.text")
                .font(.subheadline.weight(.semibold)).foregroundStyle(TBPalette.foreground)
            if let snippet = widget.arguments["snippet"], !snippet.isEmpty {
                Text(snippet).font(.subheadline).foregroundStyle(TBPalette.muted).lineLimit(5)
            }
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(TBPalette.surface, in: RoundedRectangle(cornerRadius: 16))
        .overlay(RoundedRectangle(cornerRadius: 16).stroke(TBPalette.border, lineWidth: 1))
    }
}

private struct NativeLinkWidget: View {
    let widget: NativeWidget
    let sources: [ChatContentSource]

    private var url: URL? {
        guard let raw = widget.arguments["url"], let url = URL(string: raw),
              ["https", "http"].contains(url.scheme?.lowercased() ?? "") else { return nil }
        return url
    }
    private var source: ChatContentSource? {
        guard let url else { return nil }
        return sources.first { URL(string: $0.url)?.host == url.host }
    }

    var body: some View {
        if let url {
            Link(destination: url) {
                HStack(spacing: 12) {
                    Image(systemName: "link.circle.fill").font(.system(size: 30)).foregroundStyle(TBPalette.brand)
                    VStack(alignment: .leading, spacing: 4) {
                        Text(source?.title ?? widget.arguments["source"] ?? url.host ?? url.absoluteString)
                            .font(.subheadline.weight(.semibold)).foregroundStyle(TBPalette.foreground).lineLimit(2)
                        Text(url.host ?? url.absoluteString).font(.caption).foregroundStyle(TBPalette.muted).lineLimit(1)
                    }
                    Spacer(minLength: 0)
                    Image(systemName: "arrow.up.right").font(.caption).foregroundStyle(TBPalette.muted)
                }
                .padding(14)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(TBPalette.surface, in: RoundedRectangle(cornerRadius: 16))
                .overlay(RoundedRectangle(cornerRadius: 16).stroke(TBPalette.border, lineWidth: 1))
            }.buttonStyle(.plain)
        }
    }
}

private struct NativeMapWidget: View {
    let widget: NativeWidget

    var body: some View {
        let title = widget.arguments["title"]
        let featureCount = NativeGeoJSONFeature.count(in: widget.arguments["data"] ?? "")
        if featureCount > 0 {
            VStack(alignment: .leading, spacing: 7) {
                Label(title?.isEmpty == false ? title! : nativeString( "Map"), systemImage: "map")
                    .font(.subheadline.weight(.semibold)).foregroundStyle(TBPalette.foreground)
                NativeGeoJSONCanvas(features: NativeGeoJSONFeature.decode(widget.arguments["data"] ?? ""))
                    .frame(height: 220)
                    .clipShape(RoundedRectangle(cornerRadius: 13))
                    .accessibilityLabel(nativeString( "Map with \(featureCount) features"))
                if let description = NativeGeoJSONFeature.labels(in: widget.arguments["data"] ?? "").first {
                    Text(description).font(.caption).foregroundStyle(TBPalette.muted)
                }
            }
            .padding(14)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(TBPalette.surface, in: RoundedRectangle(cornerRadius: 16))
            .overlay(RoundedRectangle(cornerRadius: 16).stroke(TBPalette.border, lineWidth: 1))
        }
    }
}

private enum NativeGeoJSONFeature {
    struct Coordinate: Identifiable {
        let longitude: Double
        let latitude: Double
        var id: String { "\(longitude),\(latitude)" }
    }
    struct Feature: Identifiable {
        let id: Int
        let kind: String
        let points: [Coordinate]
        let label: String?
    }

    static func count(in raw: String) -> Int {
        features(in: raw).count
    }

    static func decode(_ raw: String) -> [Feature] {
        features(in: raw).enumerated().compactMap { index, feature in
            guard let geometry = feature["geometry"] as? [String: Any],
                  let kind = geometry["type"] as? String,
                  let coordinates = geometry["coordinates"] else { return nil }
            let points = collectCoordinates(coordinates)
            guard !points.isEmpty else { return nil }
            let properties = feature["properties"] as? [String: Any]
            let label = (properties?["label"] as? String) ?? (properties?["name"] as? String) ?? (properties?["title"] as? String)
            return Feature(id: index, kind: kind, points: points, label: label)
        }
    }

    static func labels(in raw: String) -> [String] {
        features(in: raw).compactMap { feature in
            let properties = feature["properties"] as? [String: Any]
            return (properties?["label"] as? String) ?? (properties?["name"] as? String) ?? (properties?["title"] as? String)
        }
    }

    private static func features(in raw: String) -> [[String: Any]] {
        guard let data = raw.data(using: .utf8),
              let object = try? JSONSerialization.jsonObject(with: data),
              let root = object as? [String: Any],
              root["type"] as? String == "FeatureCollection",
              let rawFeatures = root["features"] as? [Any] else { return [] }
        return rawFeatures.compactMap { $0 as? [String: Any] }.filter { feature in
            guard let geometry = feature["geometry"] as? [String: Any],
                  let coordinates = geometry["coordinates"] else { return false }
            return coordinateCount(coordinates) > 0
        }
    }

    private static func coordinateCount(_ value: Any) -> Int {
        if let pair = value as? [NSNumber], pair.count >= 2 { return 1 }
        guard let children = value as? [Any] else { return 0 }
        return children.reduce(0) { $0 + coordinateCount($1) }
    }

    private static func collectCoordinates(_ value: Any) -> [Coordinate] {
        if let pair = value as? [NSNumber], pair.count >= 2 {
            return [Coordinate(longitude: pair[0].doubleValue, latitude: pair[1].doubleValue)]
        }
        guard let children = value as? [Any] else { return [] }
        return children.flatMap(collectCoordinates)
    }
}

private struct NativeGeoJSONCanvas: View {
    let features: [NativeGeoJSONFeature.Feature]

    private var bounds: (minX: Double, minY: Double, maxX: Double, maxY: Double) {
        let points = features.flatMap(\.points)
        let minX = points.map(\.longitude).min() ?? 0
        let maxX = points.map(\.longitude).max() ?? 1
        let minY = points.map(\.latitude).min() ?? 0
        let maxY = points.map(\.latitude).max() ?? 1
        return (minX, minY, maxX, maxY)
    }

    var body: some View {
        Canvas { context, size in
            let background = Path(CGRect(origin: .zero, size: size))
            context.fill(background, with: .color(TBPalette.secondary))
            for step in 1..<5 {
                var grid = Path()
                let x = size.width * CGFloat(step) / 5
                let y = size.height * CGFloat(step) / 5
                grid.move(to: CGPoint(x: x, y: 0)); grid.addLine(to: CGPoint(x: x, y: size.height))
                grid.move(to: CGPoint(x: 0, y: y)); grid.addLine(to: CGPoint(x: size.width, y: y))
                context.stroke(grid, with: .color(TBPalette.border.opacity(0.75)), lineWidth: 0.7)
            }
            for feature in features {
                let points = feature.points.map { project($0, in: size) }
                guard let first = points.first else { continue }
                if feature.kind.contains("LineString") {
                    var path = Path()
                    path.move(to: first)
                    points.dropFirst().forEach { path.addLine(to: $0) }
                    context.stroke(path, with: .color(TBPalette.brand), style: StrokeStyle(lineWidth: 3, lineCap: .round, lineJoin: .round))
                } else if feature.kind.contains("Polygon") {
                    var path = Path()
                    path.move(to: first)
                    points.dropFirst().forEach { path.addLine(to: $0) }
                    path.closeSubpath()
                    context.fill(path, with: .color(TBPalette.brand.opacity(0.16)))
                    context.stroke(path, with: .color(TBPalette.brand), lineWidth: 2)
                } else {
                    for point in points {
                        let rect = CGRect(x: point.x - 5, y: point.y - 5, width: 10, height: 10)
                        context.fill(Path(ellipseIn: rect), with: .color(TBPalette.brand))
                        context.stroke(Path(ellipseIn: rect.insetBy(dx: -2, dy: -2)), with: .color(TBPalette.surface), lineWidth: 2)
                    }
                }
            }
        }
        .overlay(alignment: .bottomTrailing) {
            Text(nativeString( "Offline map"))
                .font(.caption2.weight(.medium)).foregroundStyle(TBPalette.muted)
                .padding(.horizontal, 8).padding(.vertical, 5)
                .background(TBPalette.surface.opacity(0.92), in: Capsule()).padding(8)
        }
    }

    private func project(_ point: NativeGeoJSONFeature.Coordinate, in size: CGSize) -> CGPoint {
        let spanX = max(0.00001, bounds.maxX - bounds.minX)
        let spanY = max(0.00001, bounds.maxY - bounds.minY)
        let x = 20 + (point.longitude - bounds.minX) / spanX * max(0, size.width - 40)
        let y = 20 + (bounds.maxY - point.latitude) / spanY * max(0, size.height - 40)
        return CGPoint(x: x, y: y)
    }
}

private struct NativeWeatherWidget: View {
    let widget: NativeWidget
    @State private var days: [NativeWeatherDay] = []
    @State private var errorMessage: String?
    @State private var isLoading = true
    @State private var unit = "c"

    private var requestKey: String {
        [widget.arguments["location"], widget.arguments["region"], widget.arguments["country"]]
            .compactMap { $0 }.joined(separator: "|")
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            if let today = days.first {
                HStack(spacing: 10) {
                    VStack(alignment: .leading, spacing: 4) {
                        Text(nativeString( "Today"))
                            .font(.caption.weight(.medium)).foregroundStyle(TBPalette.muted)
                        HStack(alignment: .top, spacing: 1) {
                            Text("\(Int(convert(today.temperatureCelsius).rounded()))°")
                                .font(.system(size: 34, weight: .medium, design: .rounded))
                            Text(unit.uppercased()).font(.caption).foregroundStyle(TBPalette.muted).padding(.top, 5)
                        }
                        Text(today.description).font(.caption).foregroundStyle(TBPalette.muted)
                    }
                    Spacer()
                    Image(systemName: today.symbol).font(.system(size: 48)).symbolRenderingMode(.hierarchical).foregroundStyle(TBPalette.brandAmber)
                    HStack(spacing: 4) {
                        Button("°C") { unit = "c" }
                        Button("°F") { unit = "f" }
                    }
                    .font(.caption.weight(.semibold))
                    .buttonStyle(.plain)
                    .foregroundStyle(TBPalette.brand)
                }
                HStack(spacing: 5) {
                    ForEach(days.dropFirst()) { day in
                        VStack(spacing: 4) {
                            Text(weekday(day.date)).font(.caption2.weight(.medium)).foregroundStyle(TBPalette.muted)
                            Image(systemName: day.symbol).font(.caption).foregroundStyle(TBPalette.brandAmber)
                            Text("\(Int(convert(day.temperatureCelsius).rounded()))°").font(.caption.weight(.medium))
                        }
                        .frame(maxWidth: .infinity).padding(.vertical, 7)
                        .background(TBPalette.background, in: RoundedRectangle(cornerRadius: 9))
                    }
                }
            } else if isLoading {
                ProgressView(nativeString( "Loading forecast…"))
                    .frame(maxWidth: .infinity, minHeight: 88)
            } else {
                Label(errorMessage ?? nativeString( "Forecast unavailable"), systemImage: "cloud.slash")
                    .font(.subheadline).foregroundStyle(TBPalette.muted)
                    .frame(maxWidth: .infinity, minHeight: 72)
            }
            HStack {
                Link(nativeString( "Weather data provided by Open-Meteo.com"), destination: URL(string: "https://open-meteo.com")!)
                    .font(.caption2).foregroundStyle(TBPalette.muted)
                Spacer()
            }
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(TBPalette.surface, in: RoundedRectangle(cornerRadius: 16))
        .overlay(RoundedRectangle(cornerRadius: 16).stroke(TBPalette.border, lineWidth: 1))
        .task(id: requestKey) { await loadForecast() }
    }

    private func convert(_ celsius: Double) -> Double { unit == "f" ? celsius * 9 / 5 + 32 : celsius }

    private func weekday(_ value: String) -> String {
        let formatter = DateFormatter()
        formatter.dateFormat = "yyyy-MM-dd"
        guard let date = formatter.date(from: value) else { return value }
        formatter.dateFormat = "EEEEE"
        return formatter.string(from: date)
    }

    private func loadForecast() async {
        isLoading = true
        errorMessage = nil
        do {
            days = try await NativeWeatherClient().forecast(
                location: widget.arguments["location"] ?? "",
                region: widget.arguments["region"] ?? "",
                country: widget.arguments["country"] ?? ""
            )
        } catch is CancellationError {
            return
        } catch {
            errorMessage = error.localizedDescription
        }
        if !Task.isCancelled { isLoading = false }
    }
}
