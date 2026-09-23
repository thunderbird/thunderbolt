# In-App Browser

Thunderbolt can open a web page in a panel beside the chat, so you can read a linked source without
leaving the conversation.

> **Experimental.** The in-app browser has not had a full privacy or security review. It is tested on
> macOS only. Windows and Linux are expected to work but are untested.

## Availability

| Where                        | In-app browser                              |
| ---------------------------- | ------------------------------------------- |
| Desktop app (macOS)          | Available, tested                           |
| Desktop app (Windows, Linux) | Available, untested                         |
| Mobile app (iOS, Android)    | Not available. Links open in the OS browser |
| Web browser                  | Not available. Links open in a new tab      |

## Opening a page

What a link in an assistant reply does depends on your **External Links** preference in
Settings → Preferences.

| Setting           | What a link click does                                                                                                                                |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Ask** (default) | Shows a dialog with the full URL. On the desktop app you can pick the side panel or your browser; everywhere else it confirms opening in your browser |
| **Sidebar**       | Opens in the side panel immediately. Desktop app only                                                                                                 |
| **Browser**       | Opens in your default browser (a new tab on the web) with no confirmation                                                                             |

The preference is per device, not synced across your devices. On the web, **Browser** is shown as
**New tab**.

Only `http` and `https` links open in the panel. Any other link shows the confirmation dialog
instead.

## Using the panel

Drag the panel's left edge to resize it. The panel holds one thing at a time, so opening a page
replaces whatever was in it, such as an attachment preview, a tool result, or an artifact.

## Privacy

Pages open in a private session. Nothing from the page is written to disk, and each page you open
starts from a clean state with no cookies or storage carried over from the last one.

- You can sign in to a site, but the session will not survive a reload or a second visit.
- The page connects directly to the site, bypassing the backend proxy that carries your model and
  MCP traffic. The site sees your real IP address and the usual device details a browser reveals,
  such as screen size, operating system, and language.

If you are opening sensitive pages, use a VPN, and open anything you need to sign in to in your real
browser instead.

## Limitations

| Limitation            | Detail                                                                         |
| --------------------- | ------------------------------------------------------------------------------ |
| No extensions         | Ad blockers, password managers, and privacy extensions do not run in the panel |
| No shared state       | Every page starts fresh. Logins, preferences, and cookies do not carry over    |
| Slower than a browser | There is a visible delay before a page appears, on every open                  |
| No tabs or history    | One page at a time, with no back, forward, or bookmark controls                |

## Known issues

| Issue                             | Detail                                                                                                                                                                                                                |
| --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Opening pages in quick succession | Opening three or more pages within a few seconds can freeze the window. Let each page finish loading first                                                                                                            |
| Harder to resize                  | While a page is open it covers part of the panel's drag edge, so resizing takes a more precise grab                                                                                                                   |
| Password prompt                   | A few sites make the operating system ask for your login password to unlock its keychain, even though the page is in a private session. The request comes from the page, not from Thunderbolt, and you can dismiss it |

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
