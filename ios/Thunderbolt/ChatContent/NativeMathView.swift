/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import SwiftMath
import SwiftUI
import UIKit

struct NativeMathView: View {
    let source: String
    var references = ""

    private var tokens: [NativeMathToken] { NativeMathParser.tokens(source) }
    private var displayEquation: String? { NativeMathParser.displayEquation(source) }

    var body: some View {
        if let displayEquation {
            NativeMathEquationView(equation: displayEquation, mode: .display)
                .frame(maxWidth: .infinity, alignment: .center)
                .padding(.vertical, 5)
        } else if tokens.contains(where: { if case .equation = $0 { return true }; return false }) {
            NativeMathInlineFlow {
                ForEach(Array(tokens.enumerated()), id: \.offset) { _, token in
                    switch token {
                    case .text(let value):
                        Text(NativeMarkdownInline.attributed(value, references: references))
                            .fixedSize(horizontal: false, vertical: true)
                    case .equation(let value):
                        NativeMathEquationView(equation: value, mode: .text)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
            }
        } else {
            Text(NativeMarkdownInline.attributed(source, references: references))
                .fixedSize(horizontal: false, vertical: true)
        }
    }
}

enum NativeMathToken: Equatable {
    case text(String)
    case equation(String)
}

enum NativeMathParser {
    static func displayEquation(_ source: String) -> String? {
        let trimmed = source.trimmingCharacters(in: .whitespacesAndNewlines)
        for (opening, closing) in [("$$", "$$"), ("\\[", "\\]")] {
            guard trimmed.hasPrefix(opening), trimmed.hasSuffix(closing), trimmed.count >= opening.count + closing.count else { continue }
            return String(trimmed.dropFirst(opening.count).dropLast(closing.count)).trimmingCharacters(in: .whitespacesAndNewlines)
        }
        return nil
    }

    static func tokens(_ source: String) -> [NativeMathToken] {
        var result: [NativeMathToken] = []
        var cursor = source.startIndex
        var textStart = source.startIndex
        while cursor < source.endIndex {
            if source[cursor...].hasPrefix("$$") {
                cursor = source.index(cursor, offsetBy: 2)
                continue
            }
            guard let opening = opening(at: cursor, in: source) else {
                cursor = source.index(after: cursor)
                continue
            }
            let openingRange = source.range(of: opening.open, range: cursor..<source.endIndex)!
            guard let closingRange = source.range(of: opening.close, range: openingRange.upperBound..<source.endIndex) else {
                cursor = openingRange.upperBound
                continue
            }
            if openingRange.lowerBound > textStart {
                result.append(.text(String(source[textStart..<openingRange.lowerBound])))
            }
            let latex = String(source[openingRange.upperBound..<closingRange.lowerBound])
            result.append(.equation(latex))
            cursor = closingRange.upperBound
            textStart = cursor
        }
        if textStart < source.endIndex { result.append(.text(String(source[textStart...])))}
        return result.isEmpty ? [.text(source)] : result
    }

    private static func opening(at index: String.Index, in source: String) -> (open: String, close: String)? {
        let tail = source[index...]
        if tail.hasPrefix("$$") || tail.hasPrefix("\\[") { return nil }
        if tail.hasPrefix("\\\\(") { return nil }
        if tail.hasPrefix("\\(") { return ("\\(", "\\)") }
        if source[index] == "$", source.index(after: index) < source.endIndex,
           source[source.index(after: index)] != "$" { return ("$", "$") }
        return nil
    }
}

private struct NativeMathEquationView: UIViewRepresentable {
    let equation: String
    let mode: MTMathUILabelMode
    @ScaledMetric(relativeTo: .body) private var scaledFontSize: CGFloat = 17

    func makeUIView(context: Context) -> MTMathUILabel {
        let label = MTMathUILabel()
        label.setContentHuggingPriority(.required, for: .vertical)
        label.setContentCompressionResistancePriority(.required, for: .vertical)
        label.backgroundColor = .clear
        return label
    }

    func updateUIView(_ label: MTMathUILabel, context: Context) {
        label.latex = equation
        let font = MTFontManager().font(withName: MathFont.latinModernFont.rawValue, size: scaledFontSize)
        label.font = font
        label.labelMode = mode
        label.textAlignment = .left
        label.textColor = .label
        label.contentInsets = UIEdgeInsets.zero
        label.invalidateIntrinsicContentSize()
    }
}

private struct NativeMathInlineFlow: Layout {
    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        measure(proposal: proposal, subviews: subviews).size
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        let layout = measure(proposal: ProposedViewSize(width: bounds.width, height: proposal.height), subviews: subviews)
        for (index, origin) in layout.origins.enumerated() where index < subviews.count {
            let size = layout.sizes[index]
            subviews[index].place(at: CGPoint(x: bounds.minX + origin.x, y: bounds.minY + origin.y), proposal: ProposedViewSize(width: size.width, height: size.height))
        }
    }

    private func measure(proposal: ProposedViewSize, subviews: Subviews) -> (size: CGSize, origins: [CGPoint], sizes: [CGSize]) {
        let maximumWidth = max(1, proposal.width ?? 320)
        var origins: [CGPoint] = []
        var sizes: [CGSize] = []
        var x: CGFloat = 0
        var y: CGFloat = 0
        var lineHeight: CGFloat = 0
        for subview in subviews {
            var size = subview.sizeThatFits(ProposedViewSize(width: max(1, maximumWidth - x), height: proposal.height))
            size.width = min(size.width, maximumWidth)
            if x > 0, x + size.width > maximumWidth {
                x = 0
                y += lineHeight + 3
                lineHeight = 0
                size = subview.sizeThatFits(ProposedViewSize(width: maximumWidth, height: proposal.height))
                size.width = min(size.width, maximumWidth)
            }
            origins.append(CGPoint(x: x, y: y))
            sizes.append(size)
            x += size.width
            lineHeight = max(lineHeight, size.height)
        }
        return (CGSize(width: min(maximumWidth, x), height: y + lineHeight), origins, sizes)
    }
}
