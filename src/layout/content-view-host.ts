/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Whether this route draws the content view itself, so `main-layout` must not.
 *
 * The content view — artifacts, tool calls and reasoning, link previews,
 * documents — normally opens in `main-layout`'s resizable aside beside the
 * route. The Mini App route already has a right-hand pane of its own for its
 * chat, and the two in one window squeezed the app to whatever was left
 * (THU-903). Closing one to show the other fixed the squeeze but lost the
 * conversation under the aside, and brought it back with a jump.
 *
 * So on `/apps/` the content view is layered *over* the chat pane, inside the
 * route, where it can slide in and out and the chat stays put underneath
 * (`mini-app-page.tsx`). `main-layout` reads this to leave its own aside
 * collapsed; the context's open/closed state is shared either way, so a view
 * opened on one route follows the user to the next and shows up in whichever
 * host that route uses.
 *
 * Mobile is unaffected: the Mini App route shows a size notice below the
 * breakpoint, and `main-layout`'s full-window dialog keeps serving every
 * route there.
 */
export const routeHostsContentView = (pathname: string): boolean => pathname.startsWith('/apps/')
