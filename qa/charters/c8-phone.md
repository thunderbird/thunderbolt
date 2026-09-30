# c8-phone: the app on a phone

Goal: the main flows work and fit on a 390 × 844 phone screen.

Start state: fresh user, phone viewport (390 × 844), fake AI (select "Opus 5"). Every finding in this charter has
`"viewport": "phone"`.

On every screen you open, run the overflow check from the oracle list and look for clipped buttons.

1. Sign in. Open and close the sidebar drawer.
2. Chat: send a few messages, including a long one; rename a chat and delete one.
3. Skills: create, edit and delete a skill; use one from the slash (`/`) popup in the composer.
4. Projects: create a project and delete it.
5. Settings: open Preferences, Skills, Models, Connections and Devices. On Preferences change the preferred name,
   the theme and one unit; reload and check each.

Out of bounds: account deletion, sign out.

Budget: about 150 tool calls.
