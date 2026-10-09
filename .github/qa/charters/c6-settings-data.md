# c6-settings-data: settings and your data

Goal: every preference sticks, and exporting and importing data keeps it intact.

Start state: fresh user, desktop viewport, fake AI (select "Opus 5.5").

1. Settings → Preferences: change the preferred name, theme, language (switch to another language, look around, switch
   back), distance and temperature units, time format, currency and location. Reload after each change.
   Edge cases: an empty and a 300-character name, clearing the location, fast repeated toggles.
   Functions: `pref-name`, `theme`, `language`, `units`, `location`.
2. Toggle data collection (telemetry) and any proxy or privacy switch; reload and check each.
   Function: `privacy-toggles`.
3. Create some data (two chats, a skill), export your data, delete the local data, import the export, and check
   everything came back. Function: `export-import`.
4. Visit every other settings page once and check it loads. Function: `settings-pages`.

Out of bounds: account deletion, sign out, sync and Settings → Devices (c7 covers them; this leg has no sync backend).
