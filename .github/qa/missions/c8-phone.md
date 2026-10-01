# c8-phone: the app on a phone

Target: the main flows (sidebar, chat, skills, projects, settings) on a 390 × 844 phone screen.
Risks: anything that does not fit the screen or cannot be reached by touch, and changes that do not stick.
Start state: fresh user, phone viewport (390 × 844), fake AI (select "Opus 5"). Every finding in this mission has
`"viewport": "phone"`. Run the overflow check from the oracle list on every screen you open.
Out of bounds: account deletion, sign out.
