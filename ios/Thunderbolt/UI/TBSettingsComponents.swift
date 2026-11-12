/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import SwiftUI

private struct TBSettingsSidebarActionKey: EnvironmentKey {
    static let defaultValue: (@MainActor @Sendable () -> Void)? = nil
}

extension EnvironmentValues {
    var tbSettingsSidebarAction: (@MainActor @Sendable () -> Void)? {
        get { self[TBSettingsSidebarActionKey.self] }
        set { self[TBSettingsSidebarActionKey.self] = newValue }
    }
}

/// A warm, width-constrained settings page with the same floating title row and
/// scroll spacing used by Thunderbolt's mobile settings pages.
struct TBSettingsPage<Content: View>: View {
    let title: String
    var scrolling: Bool
    var leading: AnyView?
    var trailing: AnyView?
    @ViewBuilder var content: Content
    @Environment(\.tbSettingsSidebarAction) private var sidebarAction
    @Environment(\.dismiss) private var dismiss

    init(
        _ title: String,
        scrolling: Bool = true,
        leading: AnyView? = nil,
        trailing: AnyView? = nil,
        @ViewBuilder content: () -> Content
    ) {
        self.title = title
        self.scrolling = scrolling
        self.leading = leading
        self.trailing = trailing
        self.content = content()
    }

    var body: some View {
        Group {
            if scrolling {
                ZStack(alignment: .top) {
                    pageContent
                    pageHeader
                }
            } else {
                VStack(spacing: 0) {
                    pageHeader
                    pageContent
                }
            }
        }
        .background(TBPalette.background.ignoresSafeArea())
    }

    @ViewBuilder
    private var leadingAction: some View {
        if let leading {
            leading.frame(width: 48, height: 48)
        } else if let sidebarAction {
            TBSettingsHeaderButton(systemName: "sidebar.left", identifier: "openHistory", action: sidebarAction)
                .accessibilityLabel(nativeString("Toggle Sidebar"))
        } else {
            TBSettingsHeaderButton(systemName: "chevron.left", identifier: "settingsBack", action: { dismiss() })
                .accessibilityLabel(nativeString("Back"))
        }
    }

    @ViewBuilder
    private var pageContent: some View {
        if scrolling {
            ScrollView {
                contentColumn
                    .padding(.top, 72)
                    .padding(.bottom, 32)
            }
            .scrollIndicators(.hidden)
        } else {
            contentColumn.frame(maxHeight: .infinity, alignment: .top)
        }
    }

    private var pageHeader: some View {
        HStack(spacing: 12) {
            leadingAction
            Spacer(minLength: 0)
            Text(title)
                .tbFont(size: 16, weight: .semibold)
                .foregroundStyle(TBPalette.foreground)
                .lineLimit(1)
                .frame(maxWidth: 210)
                .accessibilityAddTraits(.isHeader)
            Spacer(minLength: 0)
            headerAction(trailing)
        }
        .frame(height: 56)
        .padding(.horizontal, 8)
        .frame(maxWidth: 760)
        .frame(maxWidth: .infinity)
        .background {
            LinearGradient(
                colors: [TBPalette.background, TBPalette.background.opacity(0.92), TBPalette.background.opacity(0)],
                startPoint: .top,
                endPoint: .bottom
            )
            .ignoresSafeArea(edges: .top)
        }
        .zIndex(1)
    }

    private var contentColumn: some View {
        VStack(alignment: .leading, spacing: 24) {
            content
        }
        .frame(maxWidth: 760, alignment: .leading)
        .frame(maxWidth: .infinity)
        .padding(.horizontal, 16)
    }

    @ViewBuilder
    private func headerAction(_ action: AnyView?) -> some View {
        if let action {
            action.frame(width: 48, height: 48)
        } else {
            Color.clear.frame(width: 48, height: 48)
                .accessibilityHidden(true)
        }
    }
}

/// Settings group title and warm bordered card. Contents inherit the source
/// card's 24-point inner horizontal/vertical padding and 16-point corners.
struct TBSettingsSection<Content: View>: View {
    let title: String
    var footer: String?
    @ViewBuilder var content: Content

    init(_ title: String, footer: String? = nil, @ViewBuilder content: () -> Content) {
        self.title = title
        self.footer = footer
        self.content = content()
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text(title)
                .tbFont(size: 18, weight: .semibold, relativeTo: .title3)
                .foregroundStyle(TBPalette.foreground)
                .accessibilityAddTraits(.isHeader)
            VStack(alignment: .leading, spacing: 20) {
                content
            }
            .padding(.horizontal, 24)
            .padding(.vertical, 24)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(TBPalette.surface, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 16, style: .continuous).stroke(TBPalette.border, lineWidth: 1))
            if let footer {
                Text(footer)
                    .tbFont(size: 14, weight: .regular)
                    .foregroundStyle(TBPalette.muted)
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(.horizontal, 4)
            }
        }
    }
}

/// Standard 16/14-point text hierarchy used throughout settings cards.
struct TBSettingsFieldLabel: View {
    let title: String
    var detail: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(title)
                .tbFont(size: 14, weight: .medium)
                .foregroundStyle(TBPalette.foreground)
            if let detail {
                Text(detail)
                    .tbFont(size: 14, weight: .regular)
                    .foregroundStyle(TBPalette.muted)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }
}

struct TBSettingsDivider: View {
    var body: some View {
        Rectangle()
            .fill(TBPalette.border)
            .frame(height: 1)
            .padding(.horizontal, -24)
            .accessibilityHidden(true)
    }
}

struct TBSettingsPrimaryButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .tbFont(size: 16, weight: .semibold)
            .foregroundStyle(TBPalette.brandForeground)
            .frame(minHeight: 48)
            .padding(.horizontal, 20)
            .background {
                LinearGradient(
                    colors: [TBPalette.brandAmber, TBPalette.brand],
                    startPoint: .leading,
                    endPoint: .trailing
                )
            }
            .clipShape(Capsule())
            .opacity(configuration.isPressed ? 0.9 : 1)
    }
}

extension View {
    func tbSettingsInputStyle() -> some View {
        tbFont(size: 16, weight: .regular)
            .padding(.horizontal, 12)
            .frame(minHeight: 44)
            .background(TBPalette.composer, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous).stroke(TBPalette.border, lineWidth: 1))
    }

    func tbFont(size: CGFloat, weight: Font.Weight = .regular, relativeTo: Font.TextStyle = .body) -> some View {
        modifier(TBScaledFont(size: size, weight: weight, relativeTo: relativeTo))
    }
}

private struct TBScaledFont: ViewModifier {
    @ScaledMetric private var scaledSize: CGFloat
    let weight: Font.Weight

    init(size: CGFloat, weight: Font.Weight, relativeTo: Font.TextStyle) {
        _scaledSize = ScaledMetric(wrappedValue: size, relativeTo: relativeTo)
        self.weight = weight
    }

    func body(content: Content) -> some View {
        content.font(.system(size: scaledSize, weight: weight, design: .default))
    }
}

struct TBSettingsHeaderButton: View {
    let systemName: String
    var identifier: String?
    let action: @MainActor @Sendable () -> Void

    @ViewBuilder var body: some View {
        if let identifier {
            button.accessibilityIdentifier(identifier)
        } else {
            button
        }
    }

    private var button: some View {
        Button { TBHaptics.selection(); action() } label: {
            Image(systemName: systemName)
                .tbFont(size: 17, weight: .medium)
                .foregroundStyle(TBPalette.foreground)
                .frame(width: 48, height: 48)
                .background(glassBackground(in: Circle()))
                .contentShape(Circle())
        }
        .buttonStyle(.plain)
    }

    @ViewBuilder
    private func glassBackground<S: Shape>(in shape: S) -> some View {
        if #available(iOS 26.0, *) {
            Color.clear.glassEffect(.regular, in: shape)
        } else {
            shape.fill(.ultraThinMaterial)
                .overlay(shape.stroke(TBPalette.border.opacity(0.45), lineWidth: 0.5))
        }
    }
}

struct TBSettingsNavigationRow<Destination: View>: View {
    let title: String
    var subtitle: String?
    var systemName: String
    @ViewBuilder var destination: Destination

    var body: some View {
        NavigationLink {
            destination
        } label: {
            HStack(spacing: 12) {
                Image(systemName: systemName)
                    .tbFont(size: 18, weight: .medium)
                    .foregroundStyle(TBPalette.brand)
                    .frame(width: 40, height: 40)
                    .background(TBPalette.secondary, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
                VStack(alignment: .leading, spacing: 3) {
                    Text(title)
                        .tbFont(size: 16, weight: .medium)
                        .foregroundStyle(TBPalette.foreground)
                    if let subtitle {
                        Text(subtitle)
                            .tbFont(size: 14)
                            .foregroundStyle(TBPalette.muted)
                    }
                }
                Spacer(minLength: 8)
                Image(systemName: "chevron.right")
                    .tbFont(size: 13, weight: .semibold)
                    .foregroundStyle(TBPalette.muted)
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 12)
            .frame(minHeight: 64)
            .background(TBPalette.surface, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 16, style: .continuous).stroke(TBPalette.border, lineWidth: 1))
            .contentShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
        }
        .buttonStyle(.plain)
    }
}

struct TBSettingsSelectableRow: View {
    let title: String
    var subtitle: String?
    var leading: AnyView?
    var trailing: AnyView?
    var isSelected: Bool
    var accessibilityIdentifier: String?
    let action: () -> Void

    init(
        title: String,
        subtitle: String? = nil,
        leading: AnyView? = nil,
        trailing: AnyView? = nil,
        isSelected: Bool = false,
        accessibilityIdentifier: String? = nil,
        action: @escaping () -> Void
    ) {
        self.title = title
        self.subtitle = subtitle
        self.leading = leading
        self.trailing = trailing
        self.isSelected = isSelected
        self.accessibilityIdentifier = accessibilityIdentifier
        self.action = action
    }

    var body: some View {
        HStack(spacing: 0) {
            Button(action: action) {
                HStack(spacing: 12) {
                    if let leading { leading }
                    VStack(alignment: .leading, spacing: 3) {
                        Text(title)
                            .tbFont(size: 16, weight: .medium)
                            .foregroundStyle(isSelected ? TBPalette.brand : TBPalette.foreground)
                            .lineLimit(1)
                        if let subtitle {
                            Text(subtitle)
                                .tbFont(size: 14)
                                .foregroundStyle(TBPalette.muted)
                                .lineLimit(2)
                                .multilineTextAlignment(.leading)
                        }
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                }
                .contentShape(Rectangle())
                .padding(.leading, 16)
                .padding(.vertical, 12)
            }
            .buttonStyle(.plain)
            .accessibilityIdentifier(accessibilityIdentifier ?? "")
            if let trailing {
                trailing
                    .padding(.trailing, 16)
                    .padding(.leading, 8)
            }
        }
        .frame(minHeight: 56)
        .background(isSelected ? TBPalette.secondary : TBPalette.surface, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 16, style: .continuous).stroke(TBPalette.border, lineWidth: 1))
    }
}
