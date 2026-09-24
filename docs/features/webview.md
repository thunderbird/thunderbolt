# In-App Browser

Thunderbolt can open a web page in a panel beside the chat, so you can read a linked source without
leaving the conversation.

> **Experimental.** The in-app browser has not had a full privacy or security review. It is tested on
> macOS only. Windows and Linux are expected to work but are untested.

## Availability

The panel is part of the desktop app. In the iOS and Android apps a link opens in the OS browser, and
in a web browser it opens in a new tab.

## Opening a page

What a link in an assistant reply does depends on your **External Links** preference in
Settings → Preferences.

| Setting           | What a link click does                                                                                                                                |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Ask** (default) | Shows a dialog with the full URL. On the desktop app you can pick the side panel or your browser; everywhere else it confirms opening in your browser |
| **Sidebar**       | Opens in the side panel immediately. Desktop app only                                                                                                 |
| **Browser**       | Opens in your default browser (a new tab on the web) with no confirmation                                                                             |

Each device keeps its own copy of this preference, and on the web **Browser** is shown as **New
tab**. Only `http` and `https` links open in the panel; any other link shows the confirmation dialog
instead.

## Using the panel

The panel holds one thing at a time, so opening a page replaces whatever was in it: an attachment
preview, a tool result, or an artifact.

## Privacy

Pages open in a private session. Nothing from the page is written to disk, and each page you open
starts from a clean state, with no cookies, logins, or stored preferences carried over from the last
one. You can sign in to a site, but the session will not survive a reload or a second visit.

The page connects directly to the site, bypassing the backend proxy that carries your model and MCP
traffic. The site sees your real IP address and the usual device details a browser reveals, such as
screen size, operating system, and language. If you are opening sensitive pages, use a VPN.

> Don't sign in to anything that matters here. Open it in your real browser instead.

## Limitations

Extensions do not run in the panel, which rules out ad blockers, password managers, and privacy
extensions. The panel shows one page at a time and keeps no history: there are no tabs, and no back,
forward, or bookmark controls. It is also slower than a browser. There is a visible delay before a
page appears, on every open.

## Known issues

Don't open three or more pages within a few seconds; it can freeze the window. Let each one finish
loading first.

A few sites make the operating system ask for your login password to unlock its keychain, even though
the page is in a private session. The request comes from the page, not from Thunderbolt, and you can
dismiss it.

## Rendering engine

The panel uses the browser engine your operating system provides, so page rendering matches that
engine rather than Firefox or your default browser.

| Platform | Engine                             |
| -------- | ---------------------------------- |
| macOS    | WebKit                             |
| Windows  | Microsoft Edge WebView2 (Chromium) |
| Linux    | WebKitGTK                          |

## Planned

- A security and privacy review before the feature leaves experimental status.
- Content and ad filtering inside the panel.
- Faster opens.
