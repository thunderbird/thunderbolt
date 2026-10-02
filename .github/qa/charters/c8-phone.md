# c8-phone: the app on a phone

Goal: the main flows work and fit on a 390 × 844 phone screen.

Start state: fresh user, phone viewport (390 × 844), fake AI (select "Opus 5"). Every finding in this charter has
`"viewport": "phone"`.

On every screen you open, detail and edit screens included, run the overflow check from the oracle list and look
for clipped buttons.

1. Sign in. Open and close the sidebar drawer. Function: `sidebar-drawer`.
2. Chat: send a few messages, including a long one; rename a chat and delete one.
   Functions: `chat-send`, `chat-rename-delete`.
3. Skills: create, edit and delete a skill; use one from the slash (`/`) popup in the composer. Also create a skill
   with a long name (about 100 characters) and long instructions (about 1,500 characters, with a few very long
   words), then open its detail screen and its edit screen. Functions: `skill-crud`, `skill-slash`,
   `skill-detail-fit`.
4. Projects: create a project with long instructions, open its detail and edit screens, then delete it.
   Functions: `project-create-delete`, `project-detail-fit`.
5. Settings: open Preferences, Skills, Models, Connections and Devices, and the detail screen of one model and of
   one connection. On Preferences change the preferred name, the theme and one unit; reload and check each.
   Functions: `settings-fit`, `settings-detail-fit`, `pref-changes`.

Out of bounds: account deletion, sign out.
