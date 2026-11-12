/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import SwiftUI

/// Reveals the navigation beneath the chat, matching the mobile app's left drawer.
struct SideDrawer<Content: View, Sidebar: View>: View {
    @Binding private var isPresented: Bool
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @GestureState private var dragOffset: CGFloat = 0

    private let content: Content
    private let sidebar: Sidebar

    init(
        isPresented: Binding<Bool>,
        @ViewBuilder content: () -> Content,
        @ViewBuilder sidebar: () -> Sidebar
    ) {
        self._isPresented = isPresented
        self.content = content()
        self.sidebar = sidebar()
    }

    var body: some View {
        GeometryReader { geometry in
            let drawerWidth = min(geometry.size.width * 0.8, 360)
            let travel = min(drawerWidth, max(0, (isPresented ? drawerWidth : 0) + dragOffset))

            ZStack(alignment: .leading) {
                TBPalette.sidebar.ignoresSafeArea()
                if isPresented || dragOffset > 0 {
                    sidebar
                        .frame(width: drawerWidth, height: geometry.size.height)
                        .accessibilityAction(.escape) { isPresented = false }
                }

                content
                    .frame(width: geometry.size.width, height: geometry.size.height)
                    .accessibilityElement(children: .contain)
                    .padding(.leading, travel)
                    .frame(width: geometry.size.width, alignment: .leading)
                    .shadow(color: .black.opacity(travel > 0 ? 0.16 : 0), radius: 22, x: -8, y: 0)
                    .accessibilityHidden(isPresented)
                    .allowsHitTesting(!isPresented)

                if isPresented {
                    Button { isPresented = false } label: {
                        Color.clear.contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .frame(width: geometry.size.width - travel, height: geometry.size.height)
                    .offset(x: travel)
                    .accessibilityLabel("Close sidebar")
                    .accessibilityIdentifier("closeHistory")
                }
            }
            .frame(width: geometry.size.width, height: geometry.size.height)
            .clipped()
            .contentShape(Rectangle())
            .simultaneousGesture(
                DragGesture(minimumDistance: 10)
                    .updating($dragOffset) { value, offset, _ in
                        guard canDrag(value, drawerWidth: drawerWidth) else { return }
                        offset = value.translation.width
                    }
                    .onEnded { value in
                        guard canDrag(value, drawerWidth: drawerWidth) else { return }
                        let predicted = (isPresented ? drawerWidth : 0) + value.predictedEndTranslation.width
                        isPresented = predicted > drawerWidth / 2
                    }
            )
            .animation(reduceMotion || dragOffset != 0 ? nil : .easeOut(duration: 0.2), value: isPresented)
        }
        .background((isPresented ? TBPalette.sidebar : TBPalette.background).ignoresSafeArea())
    }

    private func canDrag(_ value: DragGesture.Value, drawerWidth: CGFloat) -> Bool {
        let startsOnDragSurface = isPresented ? value.startLocation.x >= drawerWidth : value.startLocation.x <= 24
        return startsOnDragSurface && abs(value.translation.width) > abs(value.translation.height)
    }
}
